import type { AgentWebSearchProvider } from '@haohaoxue/lexora-contracts'
import type { WebSearchClient, WebSearchRequest } from './types'
import {
  AGENT_WEB_SEARCH_PROVIDER,
  WebSearchToolResponseSchema,
} from '@haohaoxue/lexora-contracts'
import {
  decodeHtml,
  getHtmlAttribute,
  getUrlSource,
  getWebSearchSnippetMaxLength,
  hasAnyClass,
  isDomainAllowed,
  normalizeDomainList,
  normalizeDomainSet,
  normalizeHttpUrl,
  stripHtml,
  truncateText,
} from './html'

const DEFAULT_USER_AGENT = 'Lexora-Agent/1.0 (+https://lexora.local)'

export interface CreateHtmlProviderWebSearchClientOptions {
  fetch?: typeof fetch
  now?: () => Date
  userAgent?: string
}

export function createBingWebSearchClient(
  options: CreateHtmlProviderWebSearchClientOptions = {},
): WebSearchClient {
  return createHtmlProviderWebSearchClient({
    ...options,
    provider: AGENT_WEB_SEARCH_PROVIDER.BING,
    searchUrl: 'https://www.bing.com/search',
    queryParam: 'q',
    parseResults: parseBingResults,
  })
}

export function createBaiduWebSearchClient(
  options: CreateHtmlProviderWebSearchClientOptions = {},
): WebSearchClient {
  return createHtmlProviderWebSearchClient({
    ...options,
    provider: AGENT_WEB_SEARCH_PROVIDER.BAIDU,
    searchUrl: 'http://www.baidu.com/s',
    queryParam: 'wd',
    parseResults: parseBaiduResults,
  })
}

export function parseBingResults(html: string, input: WebSearchRequest) {
  const maxResults = normalizeMaxResults(input.maxResults)
  const snippetMaxLength = getWebSearchSnippetMaxLength(input.searchContextSize)
  const allowedDomains = normalizeDomainSet(input.allowedDomains)
  const blockedDomains = normalizeDomainSet(input.blockedDomains)
  const itemRegex = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi
  const resultClassNames = new Set(['b_algo'])

  return collectResults({
    html,
    maxResults,
    snippetMaxLength,
    allowedDomains,
    blockedDomains,
    provider: AGENT_WEB_SEARCH_PROVIDER.BING,
    matches: [...html.matchAll(itemRegex)]
      .filter(match => hasAnyClass(getHtmlAttribute(match[0], 'class'), resultClassNames))
      .map(match => ({
        index: match.index ?? 0,
        nextIndex: (match.index ?? 0) + match[0].length,
        titleHtml: extractFirstTagText(match[1] ?? '', 'a'),
        url: normalizeHttpUrl(decodeHtml(extractFirstTagAttribute(match[1] ?? '', 'a', 'href') ?? '')),
      })),
    extractSnippet: chunk => extractFirstTagText(chunk, 'p'),
  })
}

export function parseBaiduResults(html: string, input: WebSearchRequest) {
  const maxResults = normalizeMaxResults(input.maxResults)
  const snippetMaxLength = getWebSearchSnippetMaxLength(input.searchContextSize)
  const allowedDomains = normalizeDomainSet(input.allowedDomains)
  const blockedDomains = normalizeDomainSet(input.blockedDomains)
  const titleRegex = /<h3[^>]*>\s*<a(?:\s[^>]*)?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/gi

  return collectResults({
    html,
    maxResults,
    snippetMaxLength,
    allowedDomains,
    blockedDomains,
    provider: AGENT_WEB_SEARCH_PROVIDER.BAIDU,
    matches: [...html.matchAll(titleRegex)].map((match, index, matches) => ({
      index: match.index ?? 0,
      nextIndex: matches[index + 1]?.index ?? html.length,
      titleHtml: match[2] ?? '',
      url: normalizeHttpUrl(decodeHtml(match[1] ?? '')),
    })),
    extractSnippet: chunk => extractFirstClassText(chunk, ['c-abstract', 'content-right_8Zs40']),
  })
}

function createHtmlProviderWebSearchClient(input: CreateHtmlProviderWebSearchClientOptions & {
  provider: AgentWebSearchProvider
  searchUrl: string
  queryParam: string
  parseResults: (html: string, input: WebSearchRequest) => ReturnType<typeof parseBingResults>
}): WebSearchClient {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const now = input.now ?? (() => new Date())
  const userAgent = input.userAgent ?? DEFAULT_USER_AGENT

  return {
    async search(requestInput) {
      if (!fetchImpl) {
        throw new Error('当前 Node.js 运行时不支持 fetch')
      }

      const request = normalizeWebSearchRequest(requestInput, input.provider)
      const url = new URL(input.searchUrl)
      url.searchParams.set(input.queryParam, request.query)

      const response = await fetchImpl(url, {
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': userAgent,
        },
        signal: AbortSignal.timeout(request.timeoutMs),
      })

      if (!response.ok) {
        throw new Error(`${input.provider} 搜索失败: HTTP ${response.status}`)
      }

      const html = await response.text()
      return WebSearchToolResponseSchema.parse({
        query: request.query,
        results: input.parseResults(html, request),
        providers: [input.provider],
        providerErrors: [],
        fetchedAt: now().toISOString(),
      })
    },
  }
}

function collectResults(input: {
  html: string
  maxResults: number
  snippetMaxLength: number
  allowedDomains: Set<string>
  blockedDomains: Set<string>
  provider: AgentWebSearchProvider
  matches: Array<{
    index: number
    nextIndex: number
    titleHtml: string
    url: string | null
  }>
  extractSnippet: (chunk: string) => string
}) {
  const results: Array<{
    title: string
    url: string
    snippet: string
    source: string
    provider: AgentWebSearchProvider
  }> = []
  const seenUrls = new Set<string>()

  for (const match of input.matches) {
    if (!match.url || seenUrls.has(match.url)) {
      continue
    }

    const source = getUrlSource(match.url)
    if (!source || !isDomainAllowed(source, input.allowedDomains, input.blockedDomains)) {
      continue
    }

    const title = truncateText(stripHtml(match.titleHtml), 160)
    if (!title) {
      continue
    }

    const chunk = input.html.slice(match.index, match.nextIndex)
    seenUrls.add(match.url)
    results.push({
      title,
      url: match.url,
      snippet: truncateText(input.extractSnippet(chunk), input.snippetMaxLength),
      source,
      provider: input.provider,
    })

    if (results.length >= input.maxResults) {
      break
    }
  }

  return results
}

function normalizeWebSearchRequest(input: WebSearchRequest, provider: AgentWebSearchProvider): WebSearchRequest {
  return {
    ...input,
    query: input.query.trim(),
    providers: [provider],
    maxResults: normalizeMaxResults(input.maxResults),
    timeoutMs: Math.max(1000, Math.min(30000, Math.trunc(input.timeoutMs))),
    allowedDomains: normalizeDomainList(input.allowedDomains),
    blockedDomains: normalizeDomainList(input.blockedDomains),
  }
}

function normalizeMaxResults(value: number): number {
  return Math.max(1, Math.min(10, Math.trunc(value)))
}

function extractFirstTagAttribute(html: string, tagName: string, attributeName: string): string | null {
  const tagRegex = new RegExp(`<${tagName}\\b[^>]*>`, 'i')
  const tagHtml = html.match(tagRegex)?.[0] ?? ''
  return getHtmlAttribute(tagHtml, attributeName)
}

function extractFirstTagText(html: string, tagName: string): string {
  const tagRegex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  return stripHtml(html.match(tagRegex)?.[1] ?? '')
}

function extractFirstClassText(html: string, classNames: string[]): string {
  const classPattern = classNames.map(escapeRegExp).join('|')
  const regex = new RegExp(`<[^>]+class=["'][^"']*(?:${classPattern})[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i')
  return stripHtml(html.match(regex)?.[1] ?? '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
