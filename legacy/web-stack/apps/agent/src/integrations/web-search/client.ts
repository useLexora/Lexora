import type {
  AgentWebSearchProvider,
  WebSearchProviderError,
  WebSearchResult,
} from '@haohaoxue/lexora-contracts'
import type { CreateHtmlProviderWebSearchClientOptions } from './html-providers'
import type { WebSearchClient, WebSearchRequest } from './types'
import {
  AGENT_WEB_SEARCH_PROVIDER,
  AGENT_WEB_SEARCH_PROVIDER_VALUES,
  WebSearchToolResponseSchema,
} from '@haohaoxue/lexora-contracts'
import { createDuckDuckGoWebSearchClient } from './duckduckgo'
import {
  createBaiduWebSearchClient,
  createBingWebSearchClient,

} from './html-providers'

export type CreateWebSearchClientOptions = CreateHtmlProviderWebSearchClientOptions

export function createWebSearchClient(options: CreateWebSearchClientOptions = {}): WebSearchClient {
  const clients = createProviderClients(options)
  const now = options.now ?? (() => new Date())

  return {
    async search(input) {
      const request = normalizeAggregateRequest(input)
      const providerErrors: WebSearchProviderError[] = []
      const results: WebSearchResult[] = []
      const seenUrls = new Set<string>()

      for (const provider of request.providers) {
        const client = clients.get(provider)
        if (!client) {
          providerErrors.push({
            provider,
            reason: `暂不支持的网络搜索服务: ${provider}`,
          })
          continue
        }

        try {
          const response = await client.search({
            ...request,
            providers: [provider],
          })

          for (const result of response.results) {
            if (seenUrls.has(result.url)) {
              continue
            }

            seenUrls.add(result.url)
            results.push(result)
          }
        }
        catch (error) {
          providerErrors.push({
            provider,
            reason: formatProviderError(error),
          })
        }
      }

      if (results.length === 0 && providerErrors.length > 0) {
        throw new Error(providerErrors.map(error => `${error.provider}: ${error.reason}`).join('; '))
      }

      return WebSearchToolResponseSchema.parse({
        query: request.query,
        providers: request.providers,
        providerErrors,
        results: results.slice(0, request.maxResults),
        fetchedAt: now().toISOString(),
      })
    },
  }
}

function createProviderClients(options: CreateWebSearchClientOptions): Map<AgentWebSearchProvider, WebSearchClient> {
  return new Map([
    [AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO, createDuckDuckGoWebSearchClient(options)],
    [AGENT_WEB_SEARCH_PROVIDER.BING, createBingWebSearchClient(options)],
    [AGENT_WEB_SEARCH_PROVIDER.BAIDU, createBaiduWebSearchClient(options)],
  ])
}

function normalizeAggregateRequest(input: WebSearchRequest): WebSearchRequest {
  return {
    ...input,
    query: input.query.trim(),
    providers: normalizeProviderList(input.providers),
    maxResults: Math.max(1, Math.min(10, Math.trunc(input.maxResults))),
    timeoutMs: Math.max(1000, Math.min(30000, Math.trunc(input.timeoutMs))),
  }
}

function normalizeProviderList(providers: AgentWebSearchProvider[]): AgentWebSearchProvider[] {
  const knownProviders = new Set<AgentWebSearchProvider>(AGENT_WEB_SEARCH_PROVIDER_VALUES)
  const normalized = [...new Set(providers)].filter(provider => knownProviders.has(provider))
  return normalized.length > 0 ? normalized : [AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO]
}

function formatProviderError(error: unknown): string {
  if (isAbortLikeError(error)) {
    return 'Web search timed out.'
  }

  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Web search failed.'
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
