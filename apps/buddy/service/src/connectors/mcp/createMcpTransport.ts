import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import type { ConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { ConnectorRuntimeState } from '../../../../shared/connectors/connectorState'
import type { McpServerConfig } from './mcpSchemas'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { discoverOAuthServerInfo, extractWWWAuthenticateParams, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createChildProcessEnvironment } from '../../../../platform/process/childProcessEnvironment'

export function createMcpTransport(config: McpServerConfig, credential: ConnectorCredential | null, authProvider?: OAuthClientProvider, authorization?: {
  signal: AbortSignal
  discovered: (kind: ConnectorRuntimeState['authorization']) => void
}) {
  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      args: config.args,
      command: config.command,
      cwd: config.cwd ?? undefined,
      env: createChildProcessEnvironment({
        source: process.env,
        additions: credential?.type === 'stdio'
          ? Object.fromEntries(Object.entries(credential.env).filter(([key]) => !/^(?:(?:https?|all|no)_proxy|NODE_USE_ENV_PROXY)$/i.test(key)))
          : {},
      }),
      stderr: 'ignore',
      maxBufferSize: 32 * 1024 * 1024,
    })
    const close = transport.close.bind(transport)
    let closing: Promise<void> | undefined
    transport.close = () => closing ??= (async () => {
      const pid = transport.pid
      await close()
      if (pid) {
        const deadline = Date.now() + 2000
        while (processExists(pid)) {
          if (Date.now() >= deadline)
            throw new Error('MCP process did not exit')
          await delay(10)
        }
      }
    })()
    return transport
  }
  const headers = new Headers(credential?.type === 'http' ? credential.headers : undefined)
  if (credential?.type === 'http' && credential.bearerToken)
    headers.set('authorization', `Bearer ${credential.bearerToken}`)
  let checkedAuthorization = false
  return new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      if (authorization && !checkedAuthorization && (response.status === 401 || response.status === 403)) {
        checkedAuthorization = true
        let kind: ConnectorRuntimeState['authorization'] = credential?.type === 'oauth' ? 'oauth' : 'credentials'
        if (kind !== 'oauth') {
          try {
            const signal = AbortSignal.any([authorization.signal, AbortSignal.timeout(5_000)])
            const info = await discoverOAuthServerInfo(config.url, {
              resourceMetadataUrl: extractWWWAuthenticateParams(response).resourceMetadataUrl,
              fetchFn: (url, options) => fetch(url, { ...options, redirect: 'error', signal }),
            })
            if (info.authorizationServerMetadata?.authorization_endpoint)
              kind = 'oauth'
          }
          catch {}
        }
        if (!authorization.signal.aborted)
          authorization.discovered(kind)
      }
      return response
    },
    requestInit: { headers, redirect: 'error' },
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      maxRetries: 2,
      reconnectionDelayGrowFactor: 2,
    },
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false
    throw error
  }
}
