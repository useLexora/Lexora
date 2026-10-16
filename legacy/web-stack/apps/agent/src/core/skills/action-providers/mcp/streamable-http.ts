import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpToolClient, McpToolConcurrencyMode, McpToolDefinition } from './client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000

export interface StreamableHttpMcpClientConfig {
  endpointUrl: string
  clientName: string
  clientVersion: string
  requestTimeoutMs?: number
  concurrencyMode?: McpToolConcurrencyMode
}

export function createStreamableHttpMcpToolClient(config: StreamableHttpMcpClientConfig): McpToolClient {
  let client: Client | null = null
  let transport: StreamableHTTPClientTransport | null = null
  let connecting: Promise<Client> | null = null
  let operationQueue: Promise<unknown> = Promise.resolve()

  async function connect(): Promise<Client> {
    if (client) {
      return client
    }

    if (connecting) {
      return connecting
    }

    connecting = createConnection()
      .finally(() => {
        connecting = null
      })

    return connecting
  }

  async function createConnection(): Promise<Client> {
    const nextClient = new Client({
      name: config.clientName,
      version: config.clientVersion,
    })
    const nextTransport = new StreamableHTTPClientTransport(new URL(config.endpointUrl))
    await nextClient.connect(nextTransport)

    client = nextClient
    transport = nextTransport
    return nextClient
  }

  async function runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (config.concurrencyMode !== 'serial') {
      return operation()
    }

    const running = operationQueue
      .catch(() => undefined)
      .then(operation)
    operationQueue = running.then(() => undefined, () => undefined)

    return running
  }

  return {
    async listTools(): Promise<readonly McpToolDefinition[]> {
      return runOperation(async () => {
        const result = await (await connect()).listTools(undefined, {
          timeout: config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
        })

        return result.tools
      })
    },
    async callTool(input) {
      return runOperation(async () =>
        (await (await connect()).callTool({
          name: input.name,
          arguments: input.arguments,
        }, undefined, {
          timeout: config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
        })) as CallToolResult,
      )
    },
    async close() {
      await runOperation(async () => {
        await transport?.close()
        transport = null
        client = null
      })
    },
  }
}
