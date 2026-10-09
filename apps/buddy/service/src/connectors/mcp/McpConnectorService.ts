import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ConnectorCredential, OAuthConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { ConnectorRuntimeState, ConnectorToolSummary } from '../../../../shared/connectors/connectorState'
import type { Event, ListenerErrorHandler } from '../../../../shared/events/Emitter'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityResourceRevision } from '../../agent/extensions/BuddyCapability'
import type { BuddyToolDisclosurePolicy } from '../../agent/extensions/discovery/toolDiscoveryContract'
import type { BuddyToolClassification } from '../../approvals/toolClassification'
import type { ConnectorRepository, McpServerRecord, McpServerWrite } from '../../storage/connectorRepository'
import type { McpConnectionEvent, McpConnectorDetails, McpConnectorEvent } from './mcpEvents'
import type { McpServerConfig } from './mcpSchemas'
import type { McpResultWriter } from './mcpToolResults'
import { createHash, randomUUID } from 'node:crypto'
import { connectorCredentialSchema } from '../../../../shared/connectors/connectorCredentials'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { credentialMutationResultSchema, credentialReadResultSchema } from '../../../../shared/runtime/credentialProtocol'
import { createMcpTools } from './createMcpTools'
import { McpConnectionManager } from './McpConnectionManager'
import { McpClientError, mcpErrorCode } from './mcpErrors'
import { loginMcpOAuth, McpOAuthProvider } from './McpOAuthProvider'
import { mcpServerConfigSchema } from './mcpSchemas'
import { McpToolNames } from './mcpToolNames'
import { waitForMcpOperation } from './waitForMcpOperation'

export interface ConnectorSecretStore {
  delete: (id: string) => Promise<void>
  read: (id: string) => Promise<ConnectorCredential | null>
  write: (id: string, credential: ConnectorCredential) => Promise<void>
}

export interface McpConnectorServiceOptions {
  connectors: ConnectorRepository
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
  readonly #secrets: ConnectorSecretStore
  readonly #manager: McpConnectionManager
  readonly #toolNames = new McpToolNames()
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
    this.#secrets = options.secrets
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
  state(id: string): ConnectorRuntimeState { return this.#manager.state(id) }
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
    return this.#mutate(parsed.data.id, async () => {
      const existing = this.#connectors.findById(parsed.data.id)
      const previousRef = existing?.credentialRef ?? null
      const credentialChanged = changesCredential(existing, input.credential)
      if (input.credential.mode === 'keep' && previousRef && existing && !sameExecutionTarget(existing, parsed.data))
        throw new McpConnectorError('VALIDATION_FAILED')
      if (input.credential.mode === 'replace' && (!connectorCredentialSchema.safeParse(input.credential.value).success || !credentialMatchesTransport(input.credential.value, parsed.data.transport)))
        throw new McpConnectorError('VALIDATION_FAILED')
      const previous = previousRef && credentialChanged ? await this.#secrets.read(previousRef) : null
      const credentialRef = input.credential.mode === 'replace' ? previousRef ?? parsed.data.id : input.credential.mode === 'keep' ? previousRef : null
      let record: McpServerRecord
      try {
        if (input.credential.mode === 'replace')
          await this.#writeCredential(credentialRef!, input.credential.value, parsed.data.id)
        else if (input.credential.mode === 'clear' && previousRef)
          await this.#deleteCredential(previousRef, parsed.data.id)
        record = this.#persistConfig({ ...parsed.data, credentialRef }, credentialChanged)
      }
      catch (error) {
        if (credentialChanged)
          await this.#restoreSecret(credentialRef ?? previousRef ?? parsed.data.id, previous, parsed.data.id)
        throw error
      }
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
    return this.#mutate(id, async () => this.#persistConfig(toConfig({ ...this.#requireConnector(id), enabled })), () => this.#connectors.findById(id)?.enabled !== enabled)
  }

  async saveCredential(id: string, credential: ConnectorCredential): Promise<void> {
    credential = copyEventSnapshot(credential)
    await this.#mutate(id, async () => {
      const record = this.#requireConnector(id)
      const parsed = connectorCredentialSchema.safeParse(credential)
      if (!parsed.success || !credentialMatchesTransport(parsed.data, record.transport))
        throw new McpConnectorError('VALIDATION_FAILED')
      const credentialRef = record.credentialRef ?? record.id
      const previous = await this.#secrets.read(credentialRef)
      try {
        await this.#writeCredential(credentialRef, parsed.data, id)
        this.#persistConfig(toConfig({ ...record, credentialRef, enabled: record.transport === 'stdio' ? false : record.enabled }), true)
      }
      catch (error) {
        await this.#restoreSecret(credentialRef, previous, id)
        throw error
      }
      this.#manager.clearCatalog(id)
    })
  }

  async clearCredential(id: string): Promise<void> {
    await this.#mutate(id, async () => {
      const record = this.#requireConnector(id)
      if (!record.credentialRef)
        return
      const previous = await this.#secrets.read(record.credentialRef)
      try {
        await this.#deleteCredential(record.credentialRef, id)
        this.#persistConfig(toConfig({ ...record, credentialRef: null, enabled: record.transport === 'stdio' ? false : record.enabled }), true)
      }
      catch (error) {
        await this.#restoreSecret(record.credentialRef, previous, id)
        throw error
      }
      this.#manager.clearCatalog(id)
    }, () => this.#connectors.findById(id)?.credentialRef != null)
  }

  remove(id: string): Promise<boolean> {
    return this.#mutate(id, async () => {
      const record = this.#connectors.findById(id)
      if (!record)
        return false
      const previous = record.credentialRef ? await this.#secrets.read(record.credentialRef) : null
      if (record.credentialRef)
        await this.#deleteCredential(record.credentialRef, id)
      let removed: boolean
      try {
        removed = this.#connectors.remove(id)
      }
      catch (error) {
        if (record.credentialRef)
          await this.#restoreSecret(record.credentialRef, previous, id)
        throw error
      }
      if (!removed && record.credentialRef)
        await this.#restoreSecret(record.credentialRef, previous, id)
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
        const credential = await loginMcpOAuth({ url: record.url!, signal: controller.signal, openExternal: this.#options.openExternal! })
        if (credential)
          await this.#saveOAuth(record, generation, controller.signal, credential)
        controller.signal.throwIfAborted()
        this.#manager.clearCatalog(id)
        this.#manager.resume(id)
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
      for (const tool of result.tools)
        availability.set(tool.name, () => connector.toolExposure !== 'hidden' && this.#manager.available(connector.id, generation) && this.#connectors.findById(connector.id)?.toolExposure === connector.toolExposure)
      tools.push(...result.tools)
      disclosure.push(result.disclosure)
      diagnostics.push(...result.diagnostics)
      for (const [name, classification] of result.classifications)
        classifications.set(name, classification)
    }
    return { resourceRevisions: copyEventSnapshot(resourceRevisions), classifications, diagnostics, tools, disclosure, available: name => availability.get(name)?.() ?? false }
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

  #saveOAuth(target: McpServerRecord, generation: number, signal: AbortSignal, credential: OAuthConnectorCredential): Promise<void> {
    const id = target.id
    return enqueue(this.#secretWrites, id, async () => {
      signal.throwIfAborted()
      if (this.#closed || generation !== this.#manager.generation(id))
        throw new McpClientError('MCP_CONNECTOR_CHANGED')
      const record = this.#requireConnector(id)
      if (record.transport !== 'streamable-http' || record.url !== target.url)
        throw new McpClientError('MCP_CONNECTOR_CHANGED')
      const ref = record.credentialRef ?? record.id
      const previous = await this.#secrets.read(ref)
      try {
        signal.throwIfAborted()
        await this.#writeCredential(ref, credential, id)
        signal.throwIfAborted()
        if (generation !== this.#manager.generation(id))
          throw new McpClientError('MCP_CONNECTOR_CHANGED')
        if (record.credentialRef !== ref) {
          const saved = this.#connectors.upsert({ ...record, credentialRef: ref, updatedAt: new Date().toISOString() })
          this.#configurationCommitted(record, saved)
        }
      }
      catch (error) {
        await this.#restoreSecret(ref, previous, id)
        throw error
      }
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

  async #writeCredential(ref: string, credential: ConnectorCredential, connectorId: string): Promise<void> {
    await this.#secrets.write(ref, credential)
    this.#publish(connectorId, { type: 'credential', status: 'written', presence: 'present' })
  }

  async #deleteCredential(ref: string, connectorId: string): Promise<void> {
    await this.#secrets.delete(ref)
    this.#publish(connectorId, { type: 'credential', status: 'deleted', presence: 'absent' })
  }

  async #restoreSecret(ref: string, credential: ConnectorCredential | null, connectorId: string): Promise<void> {
    try {
      if (credential)
        await this.#secrets.write(ref, credential)
      else
        await this.#secrets.delete(ref)
      this.#publish(connectorId, { type: 'credential', status: 'restored', presence: credential ? 'present' : 'absent' })
    }
    catch (error) {
      this.#publish(connectorId, { type: 'credential', status: 'restore-failed', presence: 'unknown' })
      throw error
    }
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

export class HostConnectorSecretStore implements ConnectorSecretStore {
  readonly #peer: RuntimeRpcPeerContract

  constructor(peer: RuntimeRpcPeerContract) {
    this.#peer = peer
  }

  async read(id: string): Promise<ConnectorCredential | null> {
    const response = credentialReadResultSchema.parse(await this.#peer.request(
      'host.secrets.read',
      { id, namespace: 'connectors' },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
    return response.value === null ? null : connectorCredentialSchema.parse(response.value)
  }

  async write(id: string, credential: ConnectorCredential): Promise<void> {
    const response = credentialMutationResultSchema.parse(await this.#peer.request(
      'host.secrets.write',
      { id, namespace: 'connectors', value: connectorCredentialSchema.parse(credential) },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
  }

  async delete(id: string): Promise<void> {
    const response = credentialMutationResultSchema.parse(await this.#peer.request(
      'host.secrets.delete',
      { id, namespace: 'connectors' },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
  }
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
