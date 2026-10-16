import type { AgentWebSearchProvider } from '@haohaoxue/lexora-contracts'
import type { ToolCall } from '@langchain/core/messages'
import type { WebSearchClient } from '../../../../../integrations/web-search'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_WEB_SEARCH_DEFAULT_TIMEOUT_MS,
  WebSearchToolResponseSchema,
} from '@haohaoxue/lexora-contracts'
import { ToolMessage } from '@langchain/core/messages'
import { normalizeDomainList } from '../../../../../integrations/web-search/html'
import { WebSearchToolInputSchema } from './schemas'
import { resolveWebSearchSkillConfig } from './tools'

export async function executeWebSearchToolCalls(input: {
  context: AgentGraphContext
  webSearch: WebSearchClient
  toolCalls: ToolCall[]
}): Promise<{
  toolMessages: ToolMessage[]
}> {
  const toolMessages: ToolMessage[] = []
  const config = resolveWebSearchSkillConfig(input.context)
  const configuredAllowedDomains = normalizeDomainList(config.allowedDomains)
  const configuredBlockedDomains = normalizeDomainList(config.blockedDomains)

  for (const toolCall of input.toolCalls) {
    try {
      const args = WebSearchToolInputSchema.parse(toolCall.args)
      const requestedAllowedDomains = normalizeDomainList(args.allowedDomains)
      const requestedBlockedDomains = normalizeDomainList(args.blockedDomains)
      const response = await input.webSearch.search({
        query: args.query,
        providers: resolveRequestedProviders(args.providers, config.providers),
        maxResults: Math.min(args.maxResults ?? config.maxResults, config.maxResults),
        timeoutMs: AGENT_WEB_SEARCH_DEFAULT_TIMEOUT_MS,
        searchContextSize: config.searchContextSize,
        allowedDomains: resolveEffectiveAllowedDomains(requestedAllowedDomains, configuredAllowedDomains),
        blockedDomains: [...new Set([...configuredBlockedDomains, ...requestedBlockedDomains])],
      })

      toolMessages.push(createWebSearchToolMessage(toolCall, WebSearchToolResponseSchema.parse(response)))
    }
    catch (error) {
      toolMessages.push(new ToolMessage({
        tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
        status: 'error',
        content: JSON.stringify({
          status: 'failed',
          reason: formatWebSearchToolError(error),
        }),
      }))
    }
  }

  return { toolMessages }
}

function resolveRequestedProviders(
  requestedProviders: AgentWebSearchProvider[] | undefined,
  configuredProviders: AgentWebSearchProvider[],
): AgentWebSearchProvider[] {
  if (!requestedProviders?.length) {
    return configuredProviders
  }

  const configuredProviderSet = new Set(configuredProviders)
  const allowedProviders = [...new Set(requestedProviders)].filter(provider => configuredProviderSet.has(provider))
  return allowedProviders.length > 0 ? allowedProviders : configuredProviders
}

function resolveEffectiveAllowedDomains(
  requestedDomains: string[],
  configuredDomains: string[],
): string[] {
  if (configuredDomains.length === 0) {
    return requestedDomains
  }

  if (requestedDomains.length === 0) {
    return configuredDomains
  }

  const narrowedDomains = requestedDomains.flatMap(requestedDomain =>
    configuredDomains
      .map(configuredDomain => resolveDomainPolicyIntersection(requestedDomain, configuredDomain))
      .filter((domain): domain is string => Boolean(domain)),
  )

  return narrowedDomains.length > 0
    ? [...new Set(narrowedDomains)]
    : configuredDomains
}

function resolveDomainPolicyIntersection(requestedDomain: string, configuredDomain: string): string | null {
  if (isSameOrSubdomain(requestedDomain, configuredDomain)) {
    return requestedDomain
  }

  if (isSameOrSubdomain(configuredDomain, requestedDomain)) {
    return configuredDomain
  }

  return null
}

function isSameOrSubdomain(domain: string, parentDomain: string): boolean {
  return domain === parentDomain || domain.endsWith(`.${parentDomain}`)
}

function createWebSearchToolMessage(
  toolCall: ToolCall,
  response: ReturnType<typeof WebSearchToolResponseSchema.parse>,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
    content: JSON.stringify(response),
  })
}

function formatWebSearchToolError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Web search timed out.'
  }

  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Web search failed.'
}
