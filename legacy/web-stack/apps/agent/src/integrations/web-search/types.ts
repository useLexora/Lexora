import type {
  AgentWebSearchContextSize,
  AgentWebSearchProvider,
  WebSearchToolResponse,
} from '@haohaoxue/lexora-contracts'

export interface WebSearchRequest {
  query: string
  providers: AgentWebSearchProvider[]
  maxResults: number
  timeoutMs: number
  searchContextSize?: AgentWebSearchContextSize
  allowedDomains?: string[]
  blockedDomains?: string[]
}

export interface WebSearchClient {
  search: (input: WebSearchRequest) => Promise<WebSearchToolResponse>
}
