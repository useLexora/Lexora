import type { CallToolResult, OAuthClientProvider, Progress, Tool } from '@modelcontextprotocol/client'
import type { ConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { ConnectorErrorCode, ConnectorRuntimeState } from '../../../../shared/connectors/connectorState'
import type { McpRequestFailure } from './mcpEvents'
import type { McpServerConfig } from './mcpSchemas'
import { Client, SdkHttpError } from '@modelcontextprotocol/client'
import { version } from '../../../../package.json'
import { createMcpTransport } from './createMcpTransport'
import { McpClientError, mcpErrorCode } from './mcpErrors'
import { waitForMcpOperation } from './waitForMcpOperation'

export { McpClientError } from './mcpErrors'
export type McpClientErrorCode = ConnectorErrorCode
export type McpRemoteTool = Tool

export interface McpClientSessionOptions {
  config: McpServerConfig
  credential: ConnectorCredential | null
  authProvider?: OAuthClientProvider
  assertAvailable?: () => void
  maxReconnectAttempts?: number
  onUnavailable?: (code: ConnectorErrorCode) => void
  onRequestFailure?: (failure: McpRequestFailure) => void
  onToolsChanged?: () => void
  onAuthorization?: (kind: ConnectorRuntimeState['authorization']) => void
}

export class McpClientSession {
  readonly #options: McpClientSessionOptions
  readonly #lifetime = new AbortController()
  #client: Client | null = null
  #closePromise: Promise<void> | null = null
  #connectPromise: Promise<void> | null = null
  #consecutiveFailures = 0
  #connected = false

  constructor(options: McpClientSessionOptions) {
    this.#options = options
  }

  async connect(): Promise<void> {
    this.#options.assertAvailable?.()
    if (this.#lifetime.signal.aborted)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    if (this.#connected)
      return
    if (this.#connectPromise)
      return this.#connectPromise
    if (this.#consecutiveFailures >= (this.#options.maxReconnectAttempts ?? 3))
      throw new McpClientError('MCP_RECONNECT_LIMIT_REACHED')
    const operation = this.#connect()
    this.#connectPromise = operation
    try {
      await operation
    }
    finally {
      if (this.#connectPromise === operation)
        this.#connectPromise = null
    }
  }

  async #connect(): Promise<void> {
    const client = new Client({ name: 'lexora-buddy', version }, {
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 1_500, maxRetries: 0 } },
      listMaxPages: 20,
      inputRequired: { autoFulfill: false },
      listChanged: { tools: { autoRefresh: false, onChanged: () => {
        if (this.#client === client && !this.#lifetime.signal.aborted)
          this.#options.onToolsChanged?.()
      } } },
    })
    client.onclose = () => {
      if (this.#client !== client)
        return
      this.#client = null
      this.#connected = false
      if (!this.#lifetime.signal.aborted)
        this.#options.onUnavailable?.('MCP_SERVER_DISCONNECTED')
    }
    client.onerror = (error) => {
      if (this.#client === client && !this.#lifetime.signal.aborted)
        this.#options.onUnavailable?.(mcpErrorCode(error, 'MCP_SERVER_UNAVAILABLE', this.#connected && this.#hasHttpSession(client)))
    }
    this.#client = client
    const transport = createMcpTransport(this.#options.config, this.#options.credential, this.#options.authProvider, {
      signal: this.#lifetime.signal,
      assertAvailable: this.#options.assertAvailable,
      discovered: kind => this.#options.onAuthorization?.(kind),
    })
    try {
      await client.connect(transport, {
        timeout: 10_000,
        signal: this.#lifetime.signal,
      })
      if (this.#lifetime.signal.aborted || this.#client !== client)
        throw new McpClientError('MCP_SERVER_UNAVAILABLE')
      this.#connected = true
      this.#consecutiveFailures = 0
    }
    catch (error) {
      this.#consecutiveFailures += 1
      if (this.#client === client)
        this.#client = null
      await Promise.all([client.close(), transport.close()])
      throw new McpClientError(mcpErrorCode(error), { cause: error })
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
    const deadline = AbortSignal.any([this.#signal(signal), AbortSignal.timeout(30_000)])
    for (let attempt = 0; ; attempt++) {
      await this.#waitForConnection(deadline)
      const client = this.#requireClient()
      const hasHttpSession = this.#hasHttpSession(client)
      try {
        const result = await client.listTools(undefined, {
          signal: deadline,
          timeout: 15_000,
          maxTotalTimeout: 30_000,
          cacheMode: 'refresh',
        })
        return result.tools
      }
      catch (error) {
        deadline.throwIfAborted()
        const code = mcpErrorCode(error, 'MCP_SERVER_UNAVAILABLE', hasHttpSession)
        const retrying = code === 'MCP_SESSION_EXPIRED' && attempt === 0
        this.#reportFailure('tools/list', error, code, retrying)
        if (code !== 'MCP_SESSION_EXPIRED')
          throw error
        if (this.#client === client) {
          this.#client = null
          this.#connected = false
          await client.close()
        }
        if (!retrying)
          throw new McpClientError(code, { cause: error })
      }
    }
  }

  async callTool(name: string, arguments_: unknown, signal?: AbortSignal, onProgress?: (progress: Progress) => void): Promise<CallToolResult> {
    await this.#waitForConnection(signal)
    const client = this.#requireClient()
    const hasHttpSession = this.#hasHttpSession(client)
    try {
      return await client.callTool({
        name,
        arguments: isRecord(arguments_) ? arguments_ : {},
      }, {
        signal: this.#signal(signal),
        timeout: 60_000,
        maxTotalTimeout: 300_000,
        resetTimeoutOnProgress: true,
        onprogress: onProgress,
      })
    }
    catch (error) {
      if (signal?.aborted)
        throw error
      const code = mcpErrorCode(error, 'MCP_TOOL_FAILED', hasHttpSession)
      this.#reportFailure('tools/call', error, code, false)
      throw new McpClientError(code, { cause: error })
    }
  }

  close(): Promise<void> {
    return this.#closePromise ??= this.#close()
  }

  async #close(): Promise<void> {
    this.#lifetime.abort()
    this.#connected = false
    const client = this.#client
    this.#client = null
    await client?.close()
    await this.#connectPromise?.catch(() => {})
  }

  async #waitForConnection(signal?: AbortSignal) {
    signal?.throwIfAborted()
    await waitForMcpOperation(this.connect(), signal)
  }

  #hasHttpSession(client: Client): boolean {
    return this.#options.config.transport === 'streamable-http' && Boolean(client.transport?.sessionId)
  }

  #reportFailure(method: McpRequestFailure['method'], error: unknown, errorCode: ConnectorErrorCode, retrying: boolean): void {
    this.#options.onRequestFailure?.({ method, errorCode, retrying, ...(error instanceof SdkHttpError ? { httpStatus: error.status } : {}) })
  }

  #signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal
  }

  #requireClient(): Client {
    this.#options.assertAvailable?.()
    if (!this.#client || !this.#connected || this.#lifetime.signal.aborted)
      throw new McpClientError('MCP_SERVER_UNAVAILABLE')
    return this.#client
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
