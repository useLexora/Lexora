import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ConnectorCredential, OAuthConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { ConnectorRuntimeState, ConnectorToolSummary } from '../../../../shared/connectors/connectorState'
import type { Event, ListenerErrorHandler } from '../../../../shared/events/Emitter'
import type { BuddyCapabilityResourceRevision } from '../../agent/extensions/BuddyCapability'
import type { BuddyToolDisclosurePolicy } from '../../agent/extensions/discovery/toolDiscoveryContract'
import type { BuddyToolClassification } from '../../approvals/toolClassification'
import type { ConnectorRepository, McpServerRecord, McpServerWrite } from '../../storage/connectorRepository'
import type { ManagedCapabilityRecord, ManagedCapabilityRepository } from '../../storage/managedCapabilityRepository'
import type { ConnectorSecretStore } from './McpCredentialChanges'
import type { McpConnectionEvent, McpConnectorDetails, McpConnectorEvent } from './mcpEvents'
import type { McpServerConfig } from './mcpSchemas'
import type { McpResultWriter } from './mcpToolResults'
import { createHash, randomUUID } from 'node:crypto'
import { connectorCredentialSchema } from '../../../../shared/connectors/connectorCredentials'
import { managedMcpCredentialTarget } from '../../../../shared/connectors/managedMcp'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { createMcpTools } from './createMcpTools'
import { McpConnectionManager } from './McpConnectionManager'
import { McpCredentialChanges } from './McpCredentialChanges'
import { McpClientError, mcpErrorCode } from './mcpErrors'
import { loginMcpOAuth, McpOAuthProvider } from './McpOAuthProvider'
import { mcpServerConfigSchema } from './mcpSchemas'
import { McpToolNames } from './mcpToolNames'
import { waitForMcpOperation } from './waitForMcpOperation'

export type { ConnectorSecretStore } from './McpCredentialChanges'

export interface McpConnectorServiceOptions {
  connectors: ConnectorRepository
  managed?: ManagedCapabilityRepository
  maxReconnectAttempts?: number
  onListenerError?: ListenerErrorHandler
  secrets: ConnectorSecretStore
  openExternal?: (url: string) => Promise<void>
}

export interface BuddyMcpTools {
  disclosure: readonly BuddyToolDisclosurePolicy[]
  readonly resourceRevisions?: readonly BuddyCapabilityResourceRevision[]
  classifications: Map<string, BuddyToolClassification>
  diagnostics: Array<{ code: string, message: string }>
  tools: ToolDefinition[]
  available: (name: string) => boolean
}

export type ConnectorCredentialMutation
  = | { mode: 'keep' }
    | { mode: 'clear' }
    | { mode: 'replace', value: ConnectorCredential }

export interface SaveMcpConnectorInput {
  config: McpServerConfig
  credential: ConnectorCredentialMutation
}

export class McpConnectorService {
  readonly #connectors: ConnectorRepository
  readonly #options: McpConnectorServiceOptions
  readonly #credentials: McpCredentialChanges
  readonly #manager: McpConnectionManager
  readonly #toolNames = new McpToolNames()
  readonly #managedTargets = new Map<string, string>()
  readonly #mutations = new Map<string, Promise<unknown>>()
  readonly #secretWrites = new Map<string, Promise<unknown>>()
  readonly #logins = new Map<string, { controller: AbortController, operation: Promise<void>, operationId: string }>()
  readonly #events: Emitter<McpConnectorEvent>
  readonly sourceId = randomUUID()
  #revision = 0
  #closed = false
  #quiescing = false
  readonly #tests = new Set<Promise<unknown>>()

  constructor(options: McpConnectorServiceOptions) {
    this.#options = options
    this.#events = new Emitter(options.onListenerError ?? (() => console.error('MCP_CONNECTOR_OBSERVER_FAILED')))
    this.#connectors = options.connectors
    this.#credentials = new McpCredentialChanges(options.secrets, (id, event) => this.#publish(id, event))
    for (const source of options.managed?.listKind('mcp') ?? []) {
      if (source.kind === 'mcp' && 'authentication' in source.definition)
        this.#managedTargets.set(source.id, managedMcpCredentialTarget(source.definition))
    }
    this.#manager = new McpConnectionManager({
      repository: options.connectors,
      config: toConfig,
      readCredential: id => options.secrets.read(id),
      authProvider: (record, credential, signal) => {
        const generation = this.#manager.generation(record.id)
        return credential?.type === 'oauth'
          ? new McpOAuthProvider({ credential, signal, save: value => this.#saveOAuth(record, generation, signal, value) })
          : undefined
      },
      onListenerError: options.onListenerError,
      maxReconnectAttempts: options.maxReconnectAttempts,
    })
  }

  readonly onDidChange: Event<McpConnectorEvent> = (listener, options) => this.#events.event(listener, options)
  readonly onDidChangeConnection: Event<McpConnectionEvent> = (listener, options) => this.#manager.onDidChange(listener, options)

  start(): void { this.#manager.start() }
  async prepareForRun(signal: AbortSignal): Promise<void> {
    if (this.#quiescing)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    signal.throwIfAborted()
    const pending = this.list().filter(record => this.#manager.available(record.id, this.#manager.generation(record.id)) && this.state(record.id).updatedAt === null).map(record => this.#manager.refresh(record.id))
    await waitForMcpOperation(Promise.allSettled(pending), signal)
    signal.throwIfAborted()
  }

  list(): readonly McpServerRecord[] { return this.#connectors.list() }
  state(id: string): ConnectorRuntimeState {
    const state = this.#manager.state(id)
    const source = this.#options.managed?.get(id)
    if (!source || source.kind !== 'mcp' || !('authentication' in source.definition))
      return state
    return Object.freeze({ ...state, authorization: source.definition.authentication === 'oauth' ? 'oauth' : source.definition.authentication === 'bearer' ? 'credentials' : null })
  }

  async applyManaged(source: ManagedCapabilityRecord): Promise<void> {
    const changesTarget = () => {
      const stored = this.#connectors.findStoredById(source.id)
      const definition = this.#managedDefinition(this.#requireManaged(source.id))
      const target = this.#managedTargets.get(source.id)
      return !stored || stored.transport !== definition.transport || stored.url !== definition.url
        || (target !== undefined && target !== managedMcpCredentialTarget(definition))
    }
    await this.#mutate(source.id, async () => {
      const current = this.#requireManaged(source.id)
      const existing = this.#connectors.findById(source.id)
      const stored = this.#connectors.findStoredById(source.id)
      const definition = this.#managedDefinition(current)
      const targetChanged = changesTarget()
      const reason = existing?.managed
        ? existing.managed.unavailableReason
        : definition.authentication === 'none' ? null : 'authentication_required'
      if (!targetChanged && stored?.name === definition.name && reason === current.unavailableReason)
        return
      this.#options.managed!.setUnavailableReason(source.id, reason)
      const now = new Date().toISOString()
      const saved = this.#connectors.upsert({
        id: source.id,
        name: definition.name,
        transport: definition.transport,
        url: definition.url,
        command: null,
        args: null,
        cwd: null,
        executionConfirmedAt: null,
        enabled: false,
        credentialRef: existing?.credentialRef ?? null,
        toolNamespace: existing?.toolNamespace,
        toolExposure: existing?.toolExposure ?? 'deferred',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      this.#managedTargets.set(source.id, managedMcpCredentialTarget(definition))
      if (targetChanged)
        this.#manager.clearCatalog(source.id)
      this.#configurationCommitted(stored ? { ...stored, enabled: existing?.enabled ?? stored.enabled } : null, saved)
    }, changesTarget)
  }

  async refreshManaged(id: string): Promise<void> {
    this.#requireManaged(id)
    await this.#mutate(id, async () => {
      const record = this.#connectors.findById(id)
      if (record)
        this.#publish(id, { type: 'configuration', kind: 'updated', enabled: record.enabled, executionChanged: true })
    })
  }

  async clearManagedConfiguration(id: string): Promise<void> {
    this.#requireManaged(id)
    await this.#mutate(id, async () => {
      const record = this.#connectors.findById(id)
      if (!record) {
        this.#options.managed!.clearConfiguration(id)
        return
      }
      const saved = await this.#credentials.commit({
        connectorId: id,
        replacement: record.credentialRef ? { ref: record.credentialRef, value: null } : null,
        commit: () => this.#connectors.configureManaged(
          { ...record, credentialRef: null, enabled: false, toolExposure: 'deferred', updatedAt: new Date().toISOString() },
          { credentialTarget: null, userEnabled: false, unavailableReason: null },
        ),
      })
      this.#manager.clearCatalog(id)
      this.#configurationCommitted(record, saved)
    })
  }

  tools(id: string): ConnectorToolSummary[] {
    this.#requireConnector(id)
    return this.#manager.catalog(id).map(tool => ({ name: tool.name, title: tool.title ?? tool.annotations?.title ?? tool.name, description: tool.description ?? '', readOnly: tool.annotations?.readOnlyHint === true }))
  }

  upsert(input: McpServerConfig): Promise<McpServerRecord> {
    return this.save({ config: input, credential: { mode: 'keep' } })
  }

  async save(input: SaveMcpConnectorInput): Promise<McpServerRecord> {
    const parsed = mcpServerConfigSchema.safeParse(input.config)
    if (!parsed.success)
      throw new McpConnectorError('VALIDATION_FAILED')
    input = { config: parsed.data, credential: copyEventSnapshot(input.credential) }
    if (this.#options.managed?.get(parsed.data.id) || this.#connectors.findById(parsed.data.id)?.managed)
      return this.#saveManaged(input)
    return this.#mutate(parsed.data.id, async () => {
      const existing = this.#connectors.findById(parsed.data.id)
      const previousRef = existing?.credentialRef ?? null
      const credentialChanged = changesCredential(existing, input.credential)
      if (input.credential.mode === 'keep' && previousRef && existing && !sameExecutionTarget(existing, parsed.data))
        throw new McpConnectorError('VALIDATION_FAILED')
      if (input.credential.mode === 'replace' && (!connectorCredentialSchema.safeParse(input.credential.value).success || !credentialMatchesTransport(input.credential.value, parsed.data.transport)))
        throw new McpConnectorError('VALIDATION_FAILED')
      const credentialRef = input.credential.mode === 'replace' ? previousRef ?? parsed.data.id : input.credential.mode === 'keep' ? previousRef : null
      const record = await this.#credentials.commit({
        connectorId: parsed.data.id,
        replacement: input.credential.mode === 'replace'
          ? { ref: credentialRef!, value: input.credential.value }
          : input.credential.mode === 'clear' && previousRef ? { ref: previousRef, value: null } : null,
        commit: () => this.#persistConfig({ ...parsed.data, credentialRef }, credentialChanged),
      })
      if (!existing || !sameExecutionTarget(existing, parsed.data) || credentialChanged)
        this.#manager.clearCatalog(record.id)
      return record
    }, () => {
      const existing = this.#connectors.findById(parsed.data.id)
      return !existing || changesCredential(existing, input.credential) || existing.enabled !== parsed.data.enabled || !sameExecutionTarget(existing, parsed.data)
    })
  }

  confirmExecution(id: string): Promise<McpServerRecord> {
    return this.#mutate(id, async () => {
      const record = this.#requireConnector(id)
      if (record.transport !== 'stdio')
        throw new McpConnectorError('VALIDATION_FAILED')
      if (record.executionConfirmedAt)
        return record
      const now = new Date().toISOString()
      const saved = this.#connectors.upsert({ ...record, executionConfirmedAt: now, updatedAt: now })
      this.#configurationCommitted(record, saved)
      return saved
    }, () => !this.#connectors.findById(id)?.executionConfirmedAt)
  }

  setEnabled(id: string, enabled: boolean): Promise<McpServerRecord> {
    if (this.#options.managed?.get(id) || this.#connectors.findById(id)?.managed) {
      return this.#mutate(id, async () => {
        this.#requireManaged(id)
        const previous = this.#requireConnector(id)
        if (enabled && (previous.managed?.state !== 'enabled' || previous.managed.unavailableReason))
          throw new McpClientError(previous.managed?.unavailableReason === 'authentication_required' ? 'MCP_AUTHENTICATION_REQUIRED' : 'MCP_CONNECTOR_DISABLED')
        this.#options.managed!.setUserEnabled(id, enabled)
        const saved = this.#requireConnector(id)
        this.#configurationCommitted(previous, saved)
        return saved
      }, () => this.#connectors.findById(id)?.managed?.userEnabled !== enabled)
    }
    return this.#mutate(id, async () => this.#persistConfig(toConfig({ ...this.#requireConnector(id), enabled })), () => this.#connectors.findById(id)?.enabled !== enabled)
  }

  async saveCredential(id: string, credential: ConnectorCredential): Promise<void> {
    credential = copyEventSnapshot(credential)
    const record = this.#requireConnector(id)
    if (record.managed) {
      await this.#saveManaged({ config: toConfig({ ...record, enabled: record.managed.userEnabled }), credential: { mode: 'replace', value: credential } })
      return
    }
    await this.#mutate(id, async () => {
      const record = this.#requireConnector(id)
      const parsed = connectorCredentialSchema.safeParse(credential)
      if (!parsed.success || !credentialMatchesTransport(parsed.data, record.transport))
        throw new McpConnectorError('VALIDATION_FAILED')
      const credentialRef = record.credentialRef ?? record.id
      await this.#credentials.commit({
        connectorId: id,
        replacement: { ref: credentialRef, value: parsed.data },
        commit: () => this.#persistConfig(toConfig({ ...record, credentialRef, enabled: record.transport === 'stdio' ? false : record.enabled }), true),
      })
      this.#manager.clearCatalog(id)
    })
  }

  async clearCredential(id: string): Promise<void> {
    const record = this.#requireConnector(id)
    if (record.managed) {
      await this.#saveManaged({ config: toConfig({ ...record, enabled: record.managed.userEnabled }), credential: { mode: 'clear' } })
      return
    }
    await this.#mutate(id, async () => {
      const record = this.#requireConnector(id)
      if (!record.credentialRef)
        return
      await this.#credentials.commit({
        connectorId: id,
        replacement: { ref: record.credentialRef, value: null },
        commit: () => this.#persistConfig(toConfig({ ...record, credentialRef: null, enabled: record.transport === 'stdio' ? false : record.enabled }), true),
      })
      this.#manager.clearCatalog(id)
    }, () => this.#connectors.findById(id)?.credentialRef != null)
  }

  async remove(id: string): Promise<boolean> {
    if (this.#options.managed?.get(id) || this.#connectors.findById(id)?.managed) {
      if (this.#requireManaged(id).state !== 'removed')
        throw new McpConnectorError('MCP_MANAGED_READ_ONLY')
      await this.clearManagedConfiguration(id)
      return true
    }
    return this.#mutate(id, async () => {
      const record = this.#connectors.findById(id)
      if (!record)
        return false
      const removed = await this.#credentials.commit({
        connectorId: id,
        replacement: record.credentialRef ? { ref: record.credentialRef, value: null } : null,
        commit: () => this.#connectors.remove(id),
        committed: removed => removed,
      })
      if (removed) {
        this.#publish(id, { type: 'configuration', kind: 'removed', enabled: false, executionChanged: true })
        this.#manager.clearCatalog(id)
      }
      return removed
    }, () => this.#connectors.findById(id) !== null)
  }

  test(id: string): Promise<ConnectorRuntimeState> {
    if (this.#quiescing)
      return Promise.reject(new McpClientError('MCP_SERVER_UNAVAILABLE'))
    const pending = this.#test(id).finally(() => this.#tests.delete(pending))
    this.#tests.add(pending)
    return pending
  }

  async #test(id: string): Promise<ConnectorRuntimeState> {
    this.#requireConnector(id)
    const login = this.#logins.get(id)
    this.cancelLogin(id)
    await login?.operation
    try {
      await this.#manager.reconnect(id)
      return Object.freeze({ ...this.state(id), status: 'ready' })
    }
    catch (error) {
      const code = mcpErrorCode(error)
      const status = code === 'MCP_AUTHENTICATION_REQUIRED' ? 'needs_auth' : 'error'
      this.#manager.setState(id, status, code)
      return Object.freeze({ ...this.state(id), status })
    }
  }

  login(id: string): void {
    if (this.#quiescing)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    const record = this.#requireConnector(id)
    const source = record.managed ? this.#requireManaged(id) : null
    if (source) {
      this.#assertManagedCurrent(source)
      if (this.#managedDefinition(source).authentication !== 'oauth')
        throw new McpConnectorError('VALIDATION_FAILED')
    }
    if (record.transport !== 'streamable-http' || !record.url || !this.#options.openExternal)
      throw new McpConnectorError('VALIDATION_FAILED')
    if (this.state(id).authorization !== 'oauth') {
      void this.test(id).catch(() => {})
      return
    }
    const previous = this.#logins.get(id)
    this.cancelLogin(id)
    const controller = new AbortController()
    const operationId = randomUUID()
    const operation = Promise.resolve().then(async () => {
      await previous?.operation
      if (controller.signal.aborted)
        return
      this.#manager.pause(id)
      let generation = this.#manager.generation(id)
      try {
        await this.#manager.reset(id)
        generation = this.#manager.generation(id)
        controller.signal.throwIfAborted()
        this.#manager.setAuthorization(id, 'oauth')
        this.#manager.setState(id, 'authenticating')
        this.#publish(id, { type: 'login', operationId, status: 'started' })
        const credential = await loginMcpOAuth({ url: record.url!, signal: controller.signal, openExternal: this.#options.openExternal!, assertAvailable: source ? () => this.#assertManagedCurrent(source) : undefined })
        if (credential)
          await this.#saveOAuth(record, generation, controller.signal, credential)
        controller.signal.throwIfAborted()
        this.#manager.clearCatalog(id)
        this.#manager.resume(id)
        if (!record.managed || this.#requireConnector(id).enabled)
          await this.#manager.reconnect(id)
        this.#publish(id, { type: 'login', operationId, status: 'succeeded' })
      }
      catch (error) {
        const code = controller.signal.aborted ? 'MCP_AUTHENTICATION_CANCELLED' : mcpErrorCode(error, 'MCP_AUTHENTICATION_FAILED')
        this.#publish(id, { type: 'login', operationId, status: controller.signal.aborted ? 'cancelled' : 'failed', errorCode: code })
        if (generation === this.#manager.generation(id)) {
          this.#manager.setState(id, code === 'MCP_CONNECTOR_CHANGED' ? 'error' : 'needs_auth', code)
        }
      }
      finally {
        if (this.#logins.get(id)?.controller === controller) {
          this.#logins.delete(id)
          this.#manager.resume(id)
        }
      }
    })
    this.#logins.set(id, { controller, operation, operationId })
  }

  cancelLogin(id: string): void {
    const login = this.#logins.get(id)
    if (!login || login.controller.signal.aborted)
      return
    login.controller.abort()
    this.#manager.setState(id, 'needs_auth', 'MCP_AUTHENTICATION_CANCELLED')
  }

  resourceRevisions(): readonly BuddyCapabilityResourceRevision[] {
    return copyEventSnapshot(this.list().filter(record => this.#manager.available(record.id, this.#manager.generation(record.id))).map(record => ({
      source: 'connector' as const,
      id: record.id,
      revision: createHash('sha256').update(JSON.stringify([this.#manager.generation(record.id), this.#manager.catalogRevision(record.id), record.name, record.toolNamespace, record.toolExposure])).digest('hex'),
    })))
  }

  getTools(_signal?: AbortSignal, writeResult?: McpResultWriter): BuddyMcpTools {
    const classifications = new Map<string, BuddyToolClassification>()
    const diagnostics: BuddyMcpTools['diagnostics'] = []
    const tools: ToolDefinition[] = []
    const disclosure: BuddyToolDisclosurePolicy[] = []
    const availability = new Map<string, () => boolean>()
    const resourceRevisions = this.resourceRevisions()
    const connectors = this.list()
    const names = this.#toolNames.assign(connectors.map(connector => ({ serverId: connector.id, namespace: connector.toolNamespace, toolNames: this.#manager.catalog(connector.id).map(tool => tool.name) })))
    for (const connector of connectors.filter(record => record.enabled)) {
      const generation = this.#manager.generation(connector.id)
      if (!this.#manager.available(connector.id, generation))
        continue
      const result = createMcpTools({
        serverId: connector.id,
        serverName: connector.name,
        namespace: connector.toolNamespace,
        exposure: connector.toolExposure,
        generation,
        tools: this.#manager.catalog(connector.id),
        toolNames: names.get(connector.id),
        callTool: (tool, parameters, signal, onProgress) => this.#manager.callTool(connector.id, { generation, exposure: connector.toolExposure }, tool, parameters, signal, onProgress),
        writeResult,
      })
      for (const tool of result.tools) {
        availability.set(tool.name, () => {
          const current = this.#connectors.findById(connector.id)
          return connector.toolExposure !== 'hidden' && this.#manager.available(connector.id, generation) && current?.toolExposure === connector.toolExposure
        })
      }
      tools.push(...result.tools)
      disclosure.push(result.disclosure)
      diagnostics.push(...result.diagnostics)
      for (const [name, classification] of result.classifications)
        classifications.set(name, classification)
    }
    return { resourceRevisions: copyEventSnapshot(resourceRevisions), classifications, diagnostics, tools, disclosure, available: name => availability.get(name)?.() ?? false }
  }

  async suspendPlatform(): Promise<void> {
    this.#quiescing = true
    for (const login of this.#logins.values())
      login.controller.abort()
    const ids = this.#connectors.list().map(record => record.id)
    for (const id of ids) this.#manager.pause(id)
    const reset = Promise.allSettled(ids.map(id => this.#manager.reset(id)))
    const operations = [
      ...[...this.#logins.values()].map(login => login.operation),
      ...this.#mutations.values(),
      ...this.#secretWrites.values(),
      ...this.#tests,
    ]
    await Promise.allSettled(operations)
    const results = await reset
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length)
      throw new AggregateError(failures, 'MCP_PLATFORM_CLEANUP_FAILED')
  }

  resumePlatform(): void {
    if (this.#closed)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    this.#quiescing = false
    for (const record of this.#connectors.list()) this.#manager.resume(record.id)
  }

  async quiesce(): Promise<void> {
    this.#quiescing = true
    for (const login of this.#logins.values())
      login.controller.abort()
    const connections = this.#manager.quiesce()
    do {
      await Promise.allSettled([connections, ...[...this.#logins.values()].map(login => login.operation), ...this.#mutations.values(), ...this.#secretWrites.values(), ...this.#tests])
    } while (this.#logins.size || this.#mutations.size || this.#secretWrites.size || this.#tests.size)
  }

  async close(): Promise<void> {
    await this.quiesce()
    this.#closed = true
    try {
      await this.#manager.close()
    }
    finally {
      this.#events.dispose()
    }
  }

  #mutate<T>(id: string, action: () => Promise<T>, shouldReset: () => boolean = () => true): Promise<T> {
    if (this.#quiescing)
      return Promise.reject(new McpClientError('MCP_SERVER_UNAVAILABLE'))
    return enqueue(this.#mutations, id, async () => {
      if (this.#closed)
        throw new McpClientError('MCP_SERVER_UNAVAILABLE')
      if (!shouldReset())
        return enqueue(this.#secretWrites, id, action)
      const login = this.#logins.get(id)
      this.cancelLogin(id)
      await login?.operation
      this.#manager.pause(id)
      try {
        await this.#manager.reset(id)
        return await enqueue(this.#secretWrites, id, action)
      }
      finally {
        this.#manager.resume(id)
        if (!this.#closed && !this.#quiescing)
          this.#manager.warm(id)
      }
    })
  }

  #requireManaged(id: string): ManagedCapabilityRecord {
    const source = this.#options.managed?.get(id)
    if (!source || source.kind !== 'mcp')
      throw new McpConnectorError('MCP_MANAGED_READ_ONLY')
    return source
  }

  #managedDefinition(source: ManagedCapabilityRecord) {
    if (source.kind !== 'mcp' || !('authentication' in source.definition))
      throw new McpConnectorError('VALIDATION_FAILED')
    return source.definition
  }

  #assertManagedCurrent(source: ManagedCapabilityRecord, allowDisabled = false): void {
    const current = this.#requireManaged(source.id)
    if (current.revision !== source.revision || managedMcpCredentialTarget(this.#managedDefinition(current)) !== managedMcpCredentialTarget(this.#managedDefinition(source)))
      throw new McpClientError('MCP_CONNECTOR_CHANGED')
    if (current.state !== 'enabled' && !(allowDisabled && current.state === 'disabled'))
      throw new McpClientError('MCP_CONNECTOR_DISABLED')
  }

  #saveManaged(input: SaveMcpConnectorInput): Promise<McpServerRecord> {
    const { config, credential } = input
    return this.#mutate(config.id, async () => {
      const source = this.#requireManaged(config.id)
      const definition = this.#managedDefinition(source)
      const existing = this.#requireConnector(config.id)
      if (config.name !== definition.name || config.transport !== definition.transport
        || config.url !== definition.url || (config.toolNamespace !== undefined && config.toolNamespace !== existing.toolNamespace)) {
        throw new McpConnectorError('MCP_MANAGED_READ_ONLY')
      }
      if (source.state === 'removed' && credential.mode !== 'clear')
        throw new McpConnectorError('MCP_MANAGED_READ_ONLY')
      const replacing = credential.mode === 'replace'
      if (replacing) {
        this.#assertManagedCurrent(source, true)
        const value = connectorCredentialSchema.parse(credential.value)
        if (definition.authentication !== 'bearer' || value.type !== 'http' || !value.bearerToken || Object.keys(value.headers ?? {}).length)
          throw new McpConnectorError('VALIDATION_FAILED')
      }
      if (config.enabled && !source.userEnabled && (source.state !== 'enabled'
        || (credential.mode === 'keep' && existing.managed?.unavailableReason)
        || (credential.mode === 'clear' && definition.authentication !== 'none'))) {
        throw new McpClientError('MCP_CONNECTOR_DISABLED')
      }
      const ref = replacing ? existing.credentialRef ?? source.id : credential.mode === 'clear' ? null : existing.credentialRef
      const changed = credential.mode !== 'keep'
      const saved = await this.#credentials.commit({
        connectorId: source.id,
        replacement: replacing ? { ref: ref!, value: credential.value } : credential.mode === 'clear' && existing.credentialRef ? { ref: existing.credentialRef, value: null } : null,
        validate: () => {
          if (replacing)
            this.#assertManagedCurrent(source, true)
          else if (this.#requireManaged(source.id).revision !== source.revision)
            throw new McpClientError('MCP_CONNECTOR_CHANGED')
        },
        commit: () => this.#connectors.configureManaged(
          { ...existing, credentialRef: ref, toolExposure: config.toolExposure ?? existing.toolExposure, enabled: false, updatedAt: new Date().toISOString() },
          {
            credentialTarget: changed ? ref ? managedMcpCredentialTarget(definition) : null : source.credentialTarget,
            unavailableReason: changed ? ref || definition.authentication === 'none' ? null : 'authentication_required' : existing.managed?.unavailableReason ?? source.unavailableReason,
            userEnabled: config.enabled,
          },
        ),
      })
      if (changed)
        this.#manager.clearCatalog(source.id)
      this.#configurationCommitted(existing, saved)
      return saved
    })
  }

  #saveOAuth(target: McpServerRecord, generation: number, signal: AbortSignal, credential: OAuthConnectorCredential): Promise<void> {
    const id = target.id
    const source = target.managed ? this.#requireManaged(id) : null
    const assertCurrent = () => {
      if (source) {
        this.#assertManagedCurrent(source)
        if (source.revision !== target.managed?.revision || this.#managedDefinition(source).authentication !== 'oauth')
          throw new McpClientError('MCP_CONNECTOR_CHANGED')
      }
    }
    return enqueue(this.#secretWrites, id, async () => {
      signal.throwIfAborted()
      if (this.#closed || generation !== this.#manager.generation(id))
        throw new McpClientError('MCP_CONNECTOR_CHANGED')
      const record = this.#requireConnector(id)
      if (record.transport !== 'streamable-http' || record.url !== target.url)
        throw new McpClientError('MCP_CONNECTOR_CHANGED')
      assertCurrent()
      const ref = record.credentialRef ?? record.id
      await this.#credentials.commit({
        connectorId: id,
        replacement: { ref, value: credential },
        validate: () => {
          signal.throwIfAborted()
          if (this.#closed || generation !== this.#manager.generation(id))
            throw new McpClientError('MCP_CONNECTOR_CHANGED')
          assertCurrent()
        },
        commit: () => {
          if (source) {
            const current = this.#requireManaged(id)
            const saved = this.#connectors.configureManaged(
              { ...record, credentialRef: ref, updatedAt: new Date().toISOString() },
              { userEnabled: current.userEnabled, credentialTarget: managedMcpCredentialTarget(this.#managedDefinition(source)), unavailableReason: credential.tokens ? null : 'authentication_required' },
            )
            this.#configurationCommitted(record, saved)
          }
          else if (record.credentialRef !== ref) {
            const saved = this.#connectors.upsert({ ...record, credentialRef: ref, updatedAt: new Date().toISOString() })
            this.#configurationCommitted(record, saved)
          }
        },
      })
    })
  }

  #persistConfig(input: McpServerConfig, credentialChanged = false): McpServerRecord {
    const parsed = mcpServerConfigSchema.safeParse(input)
    if (!parsed.success)
      throw new McpConnectorError('VALIDATION_FAILED')
    const existing = this.#connectors.findById(parsed.data.id)
    if (existing && parsed.data.toolNamespace && parsed.data.toolNamespace !== existing.toolNamespace)
      throw new McpConnectorError('MCP_NAMESPACE_IMMUTABLE')
    parsed.data.toolNamespace ??= existing?.toolNamespace
    parsed.data.toolExposure ??= existing?.toolExposure ?? 'deferred'
    const executionConfirmedAt = existing && sameExecutionTarget(existing, parsed.data) && !(credentialChanged && parsed.data.transport === 'stdio') ? existing.executionConfirmedAt : null
    if (parsed.data.transport === 'stdio' && parsed.data.enabled && !executionConfirmedAt)
      throw new McpConnectorError('MCP_EXECUTION_CONFIRMATION_REQUIRED')
    const now = new Date().toISOString()
    const next = toRecord(parsed.data, existing?.createdAt ?? now, now, executionConfirmedAt)
    if (existing && sameConfiguration(existing, parsed.data) && existing.credentialRef === next.credentialRef && existing.executionConfirmedAt === next.executionConfirmedAt)
      return existing
    const saved = this.#connectors.upsert(next)
    this.#configurationCommitted(existing, saved)
    return saved
  }

  #configurationCommitted(previous: McpServerRecord | null | undefined, current: McpServerRecord): void {
    this.#publish(current.id, { type: 'configuration', kind: previous ? 'updated' : 'created', enabled: current.enabled, executionChanged: !previous || !sameExecutionTarget(previous, toConfig(current)) || previous.enabled !== current.enabled || previous.executionConfirmedAt !== current.executionConfirmedAt || previous.credentialRef !== current.credentialRef })
  }

  #publish(connectorId: string, details: McpConnectorDetails): void {
    this.#events.fire(copyEventSnapshot({ ...details, sourceId: this.sourceId, revision: ++this.#revision, connectorId, generation: this.#manager.generation(connectorId) }))
  }

  #requireConnector(id: string): McpServerRecord {
    const record = this.#connectors.findById(id)
    if (!record)
      throw new McpConnectorError('MCP_CONNECTOR_NOT_FOUND')
    return record
  }
}

function enqueue<T>(queue: Map<string, Promise<unknown>>, id: string, action: () => Promise<T>): Promise<T> {
  const operation = (queue.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
  queue.set(id, operation)
  void operation.finally(() => {
    if (queue.get(id) === operation)
      queue.delete(id)
  }).catch(() => {})
  return operation
}

export class McpConnectorError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Lexora Buddy connector configuration is invalid')
    this.name = 'McpConnectorError'
    this.code = code
  }
}

function toRecord(
  config: McpServerConfig,
  createdAt: string,
  updatedAt: string,
  executionConfirmedAt: string | null,
): McpServerWrite {
  return config.transport === 'stdio'
    ? {
        ...config,
        createdAt,
        executionConfirmedAt,
        updatedAt,
        url: null,
      }
    : {
        ...config,
        args: null,
        command: null,
        createdAt,
        cwd: null,
        executionConfirmedAt,
        updatedAt,
      }
}

function toConfig(record: McpServerRecord): McpServerConfig {
  if (record.transport === 'stdio') {
    if (!record.command || !record.args)
      throw new McpConnectorError('VALIDATION_FAILED')
    return mcpServerConfigSchema.parse({
      args: record.args,
      command: record.command,
      credentialRef: record.credentialRef,
      cwd: record.cwd,
      enabled: record.enabled,
      id: record.id,
      name: record.name,
      toolNamespace: record.toolNamespace,
      toolExposure: record.toolExposure,
      transport: record.transport,
    })
  }
  if (!record.url)
    throw new McpConnectorError('VALIDATION_FAILED')
  return mcpServerConfigSchema.parse({
    credentialRef: record.credentialRef,
    enabled: record.enabled,
    id: record.id,
    name: record.name,
    toolNamespace: record.toolNamespace,
    toolExposure: record.toolExposure,
    transport: record.transport,
    url: record.url,
  })
}

function sameExecutionTarget(record: McpServerRecord, config: McpServerConfig): boolean {
  if (record.transport !== config.transport)
    return false
  if (config.transport === 'stdio') {
    return record.command === config.command
      && JSON.stringify(record.args) === JSON.stringify(config.args)
      && record.cwd === config.cwd
  }
  return record.url === config.url
}

function changesCredential(record: McpServerRecord | null | undefined, credential: ConnectorCredentialMutation): boolean {
  return credential.mode === 'replace' || (credential.mode === 'clear' && record?.credentialRef != null)
}

function credentialMatchesTransport(
  credential: ConnectorCredential,
  transport: McpServerRecord['transport'],
): boolean {
  return transport === 'stdio' ? credential.type === 'stdio' : credential.type === 'http' || credential.type === 'oauth'
}

function sameConfiguration(existing: McpServerRecord | null | undefined, config: McpServerConfig): boolean {
  return !!existing && existing.name === config.name && existing.enabled === config.enabled
    && existing.toolNamespace === (config.toolNamespace ?? existing.toolNamespace)
    && existing.toolExposure === (config.toolExposure ?? existing.toolExposure) && sameExecutionTarget(existing, config)
}
