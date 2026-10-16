import type { AgentRuntimeSkillCredentials } from '@haohaoxue/lexora-contracts'
import type { ZodType } from 'zod'
import type { AgentGraphContext } from '../../../state'
import type { RuntimeSkillActionProvider } from '../types'
import type { McpToolClient, McpToolConcurrencyMode, McpToolDefinition } from './client'
import type { StreamableHttpMcpClientConfig } from './streamable-http'
import { createHash } from 'node:crypto'
import { createStaticMcpSkillActionProvider } from './provider'
import { createStreamableHttpMcpToolClient } from './streamable-http'

const DEFAULT_MCP_CLIENT_NAME = 'lexora-agent'
const DEFAULT_MCP_CLIENT_VERSION = '1.0.0'

interface CachedStreamableHttpMcpClient {
  client: McpToolClient
  expiresAt: number
  activeOperations: number
  retireAfterOperations: boolean
  closeStarted: boolean
}

export interface StreamableHttpMcpSkillActionProviderDefinition<TCredential extends object> {
  skillKey: string
  localToolNamePrefix: string
  tools: readonly McpToolDefinition[]
  credentialSchema: ZodType<TCredential>
  resolveEndpointUrl: (input: {
    credential: TCredential
    context: AgentGraphContext | undefined
  }) => string | null
  createCacheKey?: (input: {
    credential: TCredential
    context: AgentGraphContext | undefined
    endpointUrl: string
  }) => string
  cacheTtlMs?: number
  requestTimeoutMs?: number
  concurrencyMode?: McpToolConcurrencyMode
  clientName?: string
  clientVersion?: string
  createClient?: (config: StreamableHttpMcpClientConfig) => McpToolClient
}

const clientByCacheKey = new Map<string, CachedStreamableHttpMcpClient>()

export function createStreamableHttpMcpSkillActionProvider<TCredential extends object>(
  definition: StreamableHttpMcpSkillActionProviderDefinition<TCredential>,
): RuntimeSkillActionProvider {
  return createStaticMcpSkillActionProvider({
    skillKey: definition.skillKey,
    localToolNamePrefix: definition.localToolNamePrefix,
    tools: definition.tools,
    isAvailable({ context }) {
      return Boolean(resolveStreamableHttpMcpClientInput(definition, context))
    },
    createClient({ context }) {
      const resolved = resolveStreamableHttpMcpClientInput(definition, context)
      if (!resolved) {
        return null
      }

      const createClient = definition.createClient ?? createStreamableHttpMcpToolClient
      if (!definition.cacheTtlMs || !definition.createCacheKey) {
        return createClient(resolved.clientConfig)
      }

      pruneExpiredClients()
      const cacheKey = definition.createCacheKey({
        credential: resolved.credential,
        context,
        endpointUrl: resolved.endpointUrl,
      })
      const existing = clientByCacheKey.get(cacheKey)
      const now = Date.now()
      if (existing && existing.expiresAt > now) {
        return createCachedMcpClientLease(existing)
      }
      if (existing) {
        retireCachedClient(cacheKey, existing)
      }

      const client = createClient(resolved.clientConfig)
      const cached = {
        client,
        expiresAt: Date.now() + definition.cacheTtlMs,
        activeOperations: 0,
        retireAfterOperations: false,
        closeStarted: false,
      }
      clientByCacheKey.set(cacheKey, cached)

      return createCachedMcpClientLease(cached)
    },
  })
}

function resolveStreamableHttpMcpClientInput<TCredential extends object>(
  definition: StreamableHttpMcpSkillActionProviderDefinition<TCredential>,
  context: AgentGraphContext | undefined,
): {
  credential: TCredential
  endpointUrl: string
  clientConfig: StreamableHttpMcpClientConfig
} | null {
  const credential = resolveRuntimeSkillCredential({
    skillKey: definition.skillKey,
    skillCredentials: context?.skillCredentials,
    credentialSchema: definition.credentialSchema,
  })
  if (!credential) {
    return null
  }

  const endpointUrl = definition.resolveEndpointUrl({ credential, context })
  if (!endpointUrl) {
    return null
  }

  return {
    credential,
    endpointUrl,
    clientConfig: createClientConfig(definition, endpointUrl),
  }
}

export function createSensitiveMcpClientCacheKey(input: {
  skillKey: string
  actorUserId?: string | null
  stableParts?: readonly string[]
  sensitiveParts: readonly string[]
}): string {
  const sensitiveHash = createHash('sha256')
    .update(input.sensitiveParts.join('\0'))
    .digest('hex')
  return [
    input.skillKey,
    input.actorUserId ?? 'anonymous',
    ...(input.stableParts ?? []),
    sensitiveHash,
  ].join(':')
}

function createClientConfig<TCredential extends object>(
  definition: StreamableHttpMcpSkillActionProviderDefinition<TCredential>,
  endpointUrl: string,
): StreamableHttpMcpClientConfig {
  return {
    endpointUrl,
    clientName: definition.clientName ?? DEFAULT_MCP_CLIENT_NAME,
    clientVersion: definition.clientVersion ?? DEFAULT_MCP_CLIENT_VERSION,
    requestTimeoutMs: definition.requestTimeoutMs,
    concurrencyMode: definition.concurrencyMode,
  }
}

function resolveRuntimeSkillCredential<TCredential extends object>(input: {
  skillKey: string
  skillCredentials: AgentRuntimeSkillCredentials | null | undefined
  credentialSchema: ZodType<TCredential>
}): TCredential | null {
  const binding = input.skillCredentials?.find(item => item.key === input.skillKey)
  const result = input.credentialSchema.safeParse(binding?.credential)

  return result.success ? result.data : null
}

function pruneExpiredClients(): void {
  const now = Date.now()
  for (const [cacheKey, cached] of clientByCacheKey) {
    if (cached.expiresAt > now) {
      continue
    }

    retireCachedClient(cacheKey, cached)
  }
}

function createCachedMcpClientLease(cached: CachedStreamableHttpMcpClient): McpToolClient {
  return {
    listTools: () => runCachedClientOperation(cached, client => client.listTools()),
    callTool: input => runCachedClientOperation(cached, client => client.callTool(input)),
    close: () => closeCachedClientWhenIdle(cached),
  }
}

async function runCachedClientOperation<T>(
  cached: CachedStreamableHttpMcpClient,
  operation: (client: McpToolClient) => Promise<T>,
): Promise<T> {
  cached.activeOperations += 1
  try {
    return await operation(cached.client)
  }
  finally {
    cached.activeOperations -= 1
    if (cached.activeOperations === 0 && cached.retireAfterOperations) {
      await closeCachedClientWhenIdle(cached)
    }
  }
}

function retireCachedClient(
  cacheKey: string,
  cached: CachedStreamableHttpMcpClient,
): void {
  clientByCacheKey.delete(cacheKey)
  cached.retireAfterOperations = true
  if (cached.activeOperations === 0) {
    void closeCachedClientWhenIdle(cached)
  }
}

async function closeCachedClientWhenIdle(cached: CachedStreamableHttpMcpClient): Promise<void> {
  if (cached.closeStarted || cached.activeOperations > 0) {
    return
  }

  cached.closeStarted = true
  await cached.client.close?.()
}
