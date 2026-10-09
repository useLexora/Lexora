import type { CallToolResult, OAuthClientProvider, Progress } from '@modelcontextprotocol/client'
import type { ConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { ConnectorErrorCode, ConnectorRuntimeState } from '../../../../shared/connectors/connectorState'
import type { McpToolExposure } from '../../../../shared/connectors/mcpToolExposure'
import type { Event, ListenerErrorHandler } from '../../../../shared/events/Emitter'
import type { ConnectorRepository, McpServerRecord } from '../../storage/connectorRepository'
import type { McpCatalogTool, McpConnectionDetails, McpConnectionEvent } from './mcpEvents'
import type { McpServerConfig } from './mcpSchemas'
import { createHash, randomUUID } from 'node:crypto'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { mcpToolFingerprint, parseMcpCatalog, readMcpCatalog } from './mcpCatalog'
import { McpClientSession } from './McpClientSession'
import { McpClientError, mcpErrorCode } from './mcpErrors'
import { waitForMcpOperation } from './waitForMcpOperation'

interface Catalog {
  tools: readonly McpCatalogTool[]
  revision: string
  updatedAt: string
}

interface Connection {
  generation: number
  controller: AbortController
  session: Promise<McpClientSession>
}

interface McpToolBinding {
  generation: number
  exposure: McpToolExposure
}

export interface McpConnectionManagerOptions {
  repository: ConnectorRepository
  readCredential: (id: string) => Promise<ConnectorCredential | null>
  authProvider: (record: McpServerRecord, credential: ConnectorCredential | null, signal: AbortSignal) => OAuthClientProvider | undefined
  config: (record: McpServerRecord) => McpServerConfig
  onListenerError?: ListenerErrorHandler
  maxReconnectAttempts?: number
}

export class McpConnectionManager {
  readonly #options: McpConnectionManagerOptions
  readonly #catalogs = new Map<string, Catalog>()
  readonly #connections = new Map<string, Connection>()
  readonly #paused = new Set<string>()
  readonly #generations = new Map<string, number>()
  readonly #states = new Map<string, Pick<ConnectorRuntimeState, 'status' | 'errorCode'>>()
  readonly #authorizations = new Map<string, ConnectorRuntimeState['authorization']>()
  readonly #refreshes = new Map<string, Promise<void>>()
  readonly #background = new Set<Promise<unknown>>()
  readonly #events: Emitter<McpConnectionEvent>
  readonly sourceId = randomUUID()
  #revision = 0
  #closed = false

  constructor(options: McpConnectionManagerOptions) {
    this.#options = options
    this.#events = new Emitter(options.onListenerError ?? (() => console.error('MCP_CONNECTION_OBSERVER_FAILED')))
    for (const record of options.repository.list()) {
      const catalog = options.repository.readCatalog(record.id)
      if (!catalog)
        continue
      try {
        const tools = copyEventSnapshot(readMcpCatalog(catalog.toolsJson))
        this.#catalogs.set(record.id, { tools, revision: catalogRevision(tools), updatedAt: catalog.updatedAt })
      }
      catch { options.repository.clearCatalog(record.id) }
    }
  }

  readonly onDidChange: Event<McpConnectionEvent> = (listener, options) => this.#events.event(listener, options)

  catalogRevision(id: string): string {
    return this.#catalogs.get(id)?.revision ?? catalogRevision([])
  }

  start(): void {
    const ids = this.#options.repository.list().filter(record => record.enabled).map(record => record.id)
    this.#track(Promise.all(Array.from({ length: Math.min(ids.length, 3) }, async () => {
      while (!this.#closed && ids.length) {
        const id = ids.shift()!
        await this.refresh(id).catch(() => {})
      }
    })))
  }

  pause(id: string): void {
    const available = this.available(id, this.generation(id))
    this.#paused.add(id)
    if (available)
      this.#publish(id, { type: 'availability', available: false })
  }

  resume(id: string): void {
    if (this.#paused.delete(id) && this.available(id, this.generation(id)))
      this.#publish(id, { type: 'availability', available: true })
  }

  clearCatalog(id: string): void {
    const previous = this.#catalogs.get(id)
    this.#options.repository.clearCatalog(id)
    this.#catalogs.delete(id)
    if (previous)
      this.#publish(id, { type: 'catalog', catalogRevision: catalogRevision([]), previousRevision: previous.revision, tools: [] })
  }

  warm(id: string): void {
    if (this.#options.repository.findById(id)?.enabled)
      this.#track(this.refresh(id).catch(() => {}))
  }

  generation(id: string): number {
    return this.#generations.get(id) ?? 0
  }

  catalog(id: string): readonly McpCatalogTool[] {
    return this.#catalogs.get(id)?.tools ?? Object.freeze([])
  }

  state(id: string): ConnectorRuntimeState {
    const record = this.#options.repository.findById(id)
    const transient = this.#states.get(id)
    const status = this.#closed
      ? 'disabled'
      : transient?.status === 'connecting' || transient?.status === 'authenticating'
        ? transient.status
        : record?.enabled ? transient?.status ?? 'idle' : 'disabled'
    return Object.freeze({ status, authorization: this.#authorizations.get(id) ?? null, errorCode: transient?.errorCode ?? null, toolCount: this.catalog(id).length, updatedAt: this.#catalogs.get(id)?.updatedAt ?? null })
  }

  setState(id: string, status: ConnectorRuntimeState['status'], errorCode: ConnectorErrorCode | null = null) {
    const previous = this.state(id)
    this.#states.set(id, { status, errorCode })
    this.#publishState(id, previous)
  }

  setAuthorization(id: string, authorization: ConnectorRuntimeState['authorization']) {
    const previous = this.state(id)
    this.#authorizations.set(id, authorization)
    this.#publishState(id, previous)
  }

  available(id: string, generation: number): boolean {
    const record = this.#options.repository.findById(id)
    return !this.#closed && !this.#paused.has(id) && generation === this.generation(id) && record?.enabled === true
      && (record.transport !== 'stdio' || record.executionConfirmedAt !== null)
  }

  async reset(id: string, clearCatalog = false): Promise<void> {
    const previousGeneration = this.generation(id)
    this.#generations.set(id, previousGeneration + 1)
    this.#states.delete(id)
    this.#authorizations.delete(id)
    const connection = this.#connections.get(id)
    this.#connections.delete(id)
    connection?.controller.abort(new McpClientError('MCP_CONNECTOR_CHANGED'))
    this.#publish(id, { type: 'generation', previousGeneration })
    if (clearCatalog)
      this.clearCatalog(id)
    try {
      if (connection)
        await connection.session.then(session => session.close(), () => {})
      await this.#refreshes.get(id)?.catch(() => {})
      if (connection)
        this.#publish(id, { type: 'cleanup', status: 'completed' })
    }
    catch (error) {
      this.#publish(id, { type: 'cleanup', status: 'degraded' })
      throw error
    }
  }

  refresh(id: string): Promise<void> {
    const current = this.#refreshes.get(id)
    if (current)
      return current
    const operation = this.#refresh(id)
    this.#refreshes.set(id, operation)
    void operation.finally(() => {
      if (this.#refreshes.get(id) === operation)
        this.#refreshes.delete(id)
    }).catch(() => {})
    return operation
  }

  async #refresh(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    const generation = this.generation(id)
    this.setState(id, 'connecting')
    try {
      const connection = this.#connection(record)
      const session = await connection.session
      const tools = copyEventSnapshot(parseMcpCatalog(await session.listTools(connection.controller.signal)))
      connection.controller.signal.throwIfAborted()
      if (generation !== this.generation(id))
        return
      const previous = this.#catalogs.get(id)
      const updatedAt = new Date().toISOString()
      this.#options.repository.saveCatalog(id, JSON.stringify(tools), updatedAt)
      const revision = catalogRevision(tools)
      const previousState = this.state(id)
      this.#catalogs.set(id, { tools, revision, updatedAt })
      this.#states.set(id, { status: 'ready', errorCode: null })
      const snapshot = this.state(id)
      const events: McpConnectionEvent[] = []
      if (JSON.stringify(previousState) !== JSON.stringify(snapshot))
        events.push(this.#event(id, { type: 'state', snapshot }))
      if (previous?.revision !== revision)
        events.push(this.#event(id, { type: 'catalog', catalogRevision: revision, previousRevision: previous?.revision ?? null, tools }))
      this.#events.fireBatch(events)
    }
    catch (error) {
      if (generation !== this.generation(id) || this.#closed)
        return
      const code = mcpErrorCode(error)
      this.setState(id, code === 'MCP_AUTHENTICATION_REQUIRED' ? 'needs_auth' : 'error', code)
      throw error
    }
    finally {
      if (generation === this.generation(id) && !this.#options.repository.findById(id)?.enabled) {
        const connection = this.#connections.get(id)
        this.#connections.delete(id)
        await connection?.session.then(session => session.close(), () => {})
      }
    }
  }

  async reconnect(id: string): Promise<void> {
    this.#requireRecord(id)
    await this.reset(id)
    return this.refresh(id)
  }

  async callTool(id: string, binding: McpToolBinding, tool: McpCatalogTool, parameters: unknown, signal?: AbortSignal, onProgress?: (progress: Progress) => void): Promise<CallToolResult> {
    signal?.throwIfAborted()
    this.#assertAvailable(id, binding, tool)
    await waitForMcpOperation(this.refresh(id), signal)
    this.#assertAvailable(id, binding, tool)
    const connection = this.#connection(this.#requireRecord(id))
    const session = await connection.session
    this.#assertAvailable(id, binding, tool)
    signal?.throwIfAborted()
    const combinedSignal = signal ? AbortSignal.any([signal, connection.controller.signal]) : connection.controller.signal
    try {
      const result = await session.callTool(tool.name, parameters, combinedSignal, onProgress)
      this.setState(id, 'ready')
      return result
    }
    catch (error) {
      if (!combinedSignal.aborted) {
        const code = mcpErrorCode(error, 'MCP_TOOL_FAILED')
        if (code !== 'MCP_TOOL_FAILED')
          this.setState(id, code === 'MCP_AUTHENTICATION_REQUIRED' ? 'needs_auth' : 'error', code)
      }
      throw error
    }
  }

  async quiesce(): Promise<void> {
    const states = new Map([...this.#connections.keys()].map(id => [id, this.state(id)]))
    this.#closed = true
    for (const [id, connection] of this.#connections) {
      connection.controller.abort()
      this.#publishState(id, states.get(id)!)
    }
    while (this.#refreshes.size || this.#background.size)
      await Promise.allSettled([...this.#refreshes.values(), ...this.#background])
  }

  async close(): Promise<void> {
    await this.quiesce()
    const connections = [...this.#connections]
    this.#connections.clear()
    const results = await Promise.allSettled(connections.map(async ([id, connection]) => {
      try {
        await connection.session.then(session => session.close(), () => {})
        this.#publish(id, { type: 'cleanup', status: 'completed' })
      }
      catch (error) {
        this.#publish(id, { type: 'cleanup', status: 'degraded' })
        throw error
      }
    }))
    await Promise.allSettled([...this.#refreshes.values(), ...this.#background])
    this.#events.dispose()
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length)
      throw new AggregateError(failures, 'MCP shutdown failed')
  }

  #connection(record: McpServerRecord): Connection {
    const existing = this.#connections.get(record.id)
    if (existing)
      return existing
    const generation = this.generation(record.id)
    const controller = new AbortController()
    const connection: Connection = {
      generation,
      controller,
      session: Promise.resolve().then(async () => {
        const credential = record.credentialRef ? await this.#options.readCredential(record.credentialRef) : null
        controller.signal.throwIfAborted()
        if (credential?.type === 'oauth')
          this.setAuthorization(record.id, 'oauth')
        return new McpClientSession({
          config: this.#options.config(record),
          credential,
          authProvider: this.#options.authProvider(record, credential, controller.signal),
          onAuthorization: (kind) => {
            if (generation === this.generation(record.id) && !controller.signal.aborted)
              this.setAuthorization(record.id, kind)
          },
          maxReconnectAttempts: this.#options.maxReconnectAttempts,
          onToolsChanged: () => {
            if (generation === this.generation(record.id) && !this.#closed)
              this.#track(this.refresh(record.id).catch(() => {}))
          },
          onUnavailable: (code) => {
            if (generation === this.generation(record.id) && !controller.signal.aborted) {
              this.setState(record.id, 'error', code)
            }
          },
        })
      }),
    }
    this.#connections.set(record.id, connection)
    return connection
  }

  #assertAvailable(id: string, binding: McpToolBinding, tool: McpCatalogTool): void {
    if (binding.exposure === 'hidden' || !this.available(id, binding.generation) || this.#options.repository.findById(id)?.toolExposure !== binding.exposure)
      throw new McpClientError('MCP_CONNECTOR_DISABLED')
    const current = this.catalog(id).find(candidate => candidate.name === tool.name)
    if (!current || mcpToolFingerprint(current) !== mcpToolFingerprint(tool))
      throw new McpClientError('MCP_TOOL_CHANGED')
  }

  #requireRecord(id: string): McpServerRecord {
    const record = this.#options.repository.findById(id)
    if (this.#closed || this.#paused.has(id) || !record)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    if (record.transport === 'stdio' && !record.executionConfirmedAt)
      throw new McpClientError('MCP_EXECUTION_CONFIRMATION_REQUIRED')
    return record
  }

  #publishState(id: string, previous: ConnectorRuntimeState): void {
    const snapshot = this.state(id)
    if (JSON.stringify(previous) !== JSON.stringify(snapshot))
      this.#publish(id, { type: 'state', snapshot })
  }

  #publish(id: string, details: McpConnectionDetails): void {
    this.#events.fire(this.#event(id, details))
  }

  #event(id: string, details: McpConnectionDetails): McpConnectionEvent {
    return copyEventSnapshot({ ...details, sourceId: this.sourceId, revision: ++this.#revision, connectorId: id, generation: this.generation(id) })
  }

  #track(operation: Promise<unknown>) {
    this.#background.add(operation)
    void operation.finally(() => this.#background.delete(operation)).catch(() => {})
  }
}

function catalogRevision(tools: readonly McpCatalogTool[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}
