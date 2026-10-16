import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)
const PositiveIntegerSchema = z.number().int().positive()

export const AGENT_WEB_SEARCH_SKILL_KEY = 'lexora.web-search' as const

export const AGENT_WEB_SEARCH_TOOL = {
  SEARCH: 'web_search',
} as const

export const AGENT_WEB_SEARCH_TOOL_VALUES = [
  AGENT_WEB_SEARCH_TOOL.SEARCH,
] as const

export const AGENT_WEB_SEARCH_PROVIDER = {
  DUCKDUCKGO: 'duckduckgo',
  BING: 'bing',
  BAIDU: 'baidu',
} as const

export const AGENT_WEB_SEARCH_PROVIDER_VALUES = [
  AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO,
  AGENT_WEB_SEARCH_PROVIDER.BING,
  AGENT_WEB_SEARCH_PROVIDER.BAIDU,
] as const

export const AGENT_WEB_SEARCH_CONTEXT_SIZE = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const

export const AGENT_WEB_SEARCH_CONTEXT_SIZE_VALUES = [
  AGENT_WEB_SEARCH_CONTEXT_SIZE.LOW,
  AGENT_WEB_SEARCH_CONTEXT_SIZE.MEDIUM,
  AGENT_WEB_SEARCH_CONTEXT_SIZE.HIGH,
] as const

export const AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG = {
  providers: [AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO],
  maxResults: 5,
  searchContextSize: AGENT_WEB_SEARCH_CONTEXT_SIZE.MEDIUM,
  allowedDomains: [] as string[],
  blockedDomains: [] as string[],
} satisfies {
  providers: Array<typeof AGENT_WEB_SEARCH_PROVIDER_VALUES[number]>
  maxResults: number
  searchContextSize: typeof AGENT_WEB_SEARCH_CONTEXT_SIZE_VALUES[number]
  allowedDomains: string[]
  blockedDomains: string[]
}

export const AGENT_WEB_SEARCH_DEFAULT_TIMEOUT_MS = 8000

const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/)

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'URL must use http or https.')

export const AgentWebSearchProviderSchema = z.enum(AGENT_WEB_SEARCH_PROVIDER_VALUES)
export const AgentWebSearchContextSizeSchema = z.enum(AGENT_WEB_SEARCH_CONTEXT_SIZE_VALUES)
export const AgentWebSearchToolNameSchema = z.enum(AGENT_WEB_SEARCH_TOOL_VALUES)
export const AgentWebSearchProviderListSchema = z.array(AgentWebSearchProviderSchema)
  .min(1)
  .transform(values => [...new Set(values)])
  .refine(values => values.length > 0, 'Select at least one web search provider.')
  .refine(values => values.length <= AGENT_WEB_SEARCH_PROVIDER_VALUES.length, `Select no more than ${AGENT_WEB_SEARCH_PROVIDER_VALUES.length} web search providers.`)

export const AgentWebSearchSkillConfigSchema = z.object({
  providers: AgentWebSearchProviderListSchema.default([...AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG.providers]),
  maxResults: PositiveIntegerSchema.min(1).max(10).default(AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG.maxResults),
  searchContextSize: AgentWebSearchContextSizeSchema.default(AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG.searchContextSize),
  allowedDomains: z.array(DomainSchema).max(100).default([...AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG.allowedDomains]),
  blockedDomains: z.array(DomainSchema).max(100).default([...AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG.blockedDomains]),
}).strict().default(AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG)

export const WebSearchResultSchema = z.object({
  title: NonEmptyStringSchema,
  url: HttpUrlSchema,
  snippet: z.string().trim().default(''),
  source: NonEmptyStringSchema,
  provider: AgentWebSearchProviderSchema,
}).strict()

export const WebSearchProviderErrorSchema = z.object({
  provider: AgentWebSearchProviderSchema,
  reason: NonEmptyStringSchema,
}).strict()

export const WebSearchToolResponseSchema = z.object({
  query: NonEmptyStringSchema,
  results: z.array(WebSearchResultSchema).max(10),
  providers: AgentWebSearchProviderListSchema,
  providerErrors: z.array(WebSearchProviderErrorSchema).default([]),
  fetchedAt: z.string().datetime(),
}).strict()

export const AGENT_WEB_SEARCH_SKILL_MANIFEST = {
  title: '网络搜索',
  description: '搜索公开网页，为需要最新信息、来源验证或外部事实的问题提供引用来源。',
  tools: [
    {
      name: AGENT_WEB_SEARCH_TOOL.SEARCH,
      title: '搜索网络',
      description: '按查询词检索公开网页并返回标题、链接和摘要。',
    },
  ],
} as const

export type AgentWebSearchProvider = z.infer<typeof AgentWebSearchProviderSchema>
export type AgentWebSearchContextSize = z.infer<typeof AgentWebSearchContextSizeSchema>
export type AgentWebSearchSkillConfig = z.infer<typeof AgentWebSearchSkillConfigSchema>
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>
export type WebSearchProviderError = z.infer<typeof WebSearchProviderErrorSchema>
export type WebSearchToolResponse = z.infer<typeof WebSearchToolResponseSchema>
