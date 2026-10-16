import type { RuntimeSkillActionProvider } from '../types'
import {
  AGENT_AMAP_MCP_ENDPOINT,
  AGENT_AMAP_MCP_REQUEST_TIMEOUT_MS,
  AGENT_AMAP_MCP_SKILL_KEY,
  AGENT_AMAP_MCP_TOOL_DEFINITIONS,
  AGENT_AMAP_MCP_TOOL_PREFIX,
  AgentAmapMcpSkillCredentialConfigSchema,
} from '@haohaoxue/lexora-contracts'
import {
  createSensitiveMcpClientCacheKey,
  createStreamableHttpMcpSkillActionProvider,
} from './streamable-http-connector'

const AMAP_MCP_CLIENT_CACHE_TTL_MS = 10 * 60 * 1000

export function createAmapMcpSkillActionProvider(): RuntimeSkillActionProvider {
  return createStreamableHttpMcpSkillActionProvider({
    skillKey: AGENT_AMAP_MCP_SKILL_KEY,
    localToolNamePrefix: AGENT_AMAP_MCP_TOOL_PREFIX,
    tools: AGENT_AMAP_MCP_TOOL_DEFINITIONS,
    credentialSchema: AgentAmapMcpSkillCredentialConfigSchema,
    requestTimeoutMs: AGENT_AMAP_MCP_REQUEST_TIMEOUT_MS,
    cacheTtlMs: AMAP_MCP_CLIENT_CACHE_TTL_MS,
    resolveEndpointUrl({ credential }) {
      if (!credential.apiKey) {
        return null
      }

      return createAmapMcpEndpointUrl(credential.apiKey)
    },
    createCacheKey({ context, credential }) {
      return createSensitiveMcpClientCacheKey({
        skillKey: AGENT_AMAP_MCP_SKILL_KEY,
        actorUserId: context?.actorUserId,
        sensitiveParts: [credential.apiKey ?? ''],
      })
    },
  })
}

function createAmapMcpEndpointUrl(apiKey: string): string {
  const endpoint = new URL(AGENT_AMAP_MCP_ENDPOINT)
  endpoint.searchParams.set('key', apiKey)

  return endpoint.toString()
}
