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

const DUCKDUCKGO_LITE_SEARCH_URL = 'https://lite.duckduckgo.com/lite/'
const DEFAULT_USER_AGENT = 'Lexora-Agent/1.0 (+https://lexora.local)'
const RESULT_LINK_CLASS_NAMES = new Set(['result-link', 'result__a'])
const RESULT_SNIPPET_CLASS_NAMES = new Set(['result-snippet', 'result__snippet'])

export interface CreateDuckDuckGoWebSearchClientOptions {
  fetch?: typeof fetch
  now?: () => Date
  userAgent?: string
}

export function createDuckDuckGoWebSearchClient(
  options: CreateDuckDuckGoWebSearchClientOptions = {},
): WebSearchClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => new Date())
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

  return {
    async search(input) {
      if (!fetchImpl) {
        throw new Error('当前 Node.js 运行时不支持 fetch')
      }

      const request = normalizeWebSearchRequest(input)
      const url = new URL(DUCKDUCKGO_LITE_SEARCH_URL)
      url.searchParams.set('q', request.query)

      const response = await fetchImpl(url, {
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'user-agent': userAgent,
        },
        signal: AbortSignal.timeout(request.timeoutMs),
      })

      if (!response.ok) {
        throw new Error(`DuckDuckGo 搜索失败: HTTP ${response.status}`)
      }

      const html = await response.text()
      return WebSearchToolResponseSchema.parse({
        query: request.query,
        results: parseDuckDuckGoLiteResults(html, request),
        providers: [AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO],
        providerErrors: [],
        fetchedAt: now().toISOString(),
      })
    },
  }
}

export function parseDuckDuckGoLiteResults(
  html: string,
  input: Pick<WebSearchRequest, 'query' | 'maxResults'> & Partial<Pick<WebSearchRequest, 'allowedDomains' | 'blockedDomains' | 'searchContextSize'>>,
) {
  const maxResults = Math.max(1, Math.min(10, input.maxResults))
  const snippetMaxLength = getWebSearchSnippetMaxLength(input.searchContextSize)
  const allowedDomains = normalizeDomainSet(input.allowedDomains)
  const blockedDomains = normalizeDomainSet(input.blockedDomains)
  const links = extractResultLinks(html)
  const results: Array<{
    title: string
    url: string
    snippet: string
    source: string
    provider: typeof AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO
  }> = []
  const seenUrls = new Set<string>()

  for (const [index, match] of links.entries()) {
    const rawHref = match.href
    const rawTitle = match.innerHtml
    if (!rawHref || !rawTitle) {
      continue
    }

    const url = normalizeDuckDuckGoResultUrl(decodeHtml(rawHref))
    if (!url || seenUrls.has(url)) {
      continue
    }

    const source = getUrlSource(url)
    if (!source || !isDomainAllowed(source, allowedDomains, blockedDomains)) {
      continue
    }

    const nextMatch = links[index + 1]
    const resultHtml = html.slice(match.index, nextMatch?.index ?? html.length)
    const title = truncateText(stripHtml(rawTitle), 160)
    const snippet = truncateText(extractResultSnippet(resultHtml), snippetMaxLength)

    if (!title) {
      continue
    }

    seenUrls.add(url)
    results.push({
      title,
      url,
      snippet,
      source,
      provider: AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO,
    })

    if (results.length >= maxResults) {
      break
    }
  }

  return results
}

function normalizeWebSearchRequest(input: WebSearchRequest): WebSearchRequest {
  return {
    ...input,
    query: input.query.trim(),
    providers: [AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO],
    maxResults: Math.max(1, Math.min(10, Math.trunc(input.maxResults))),
    timeoutMs: Math.max(1000, Math.min(30000, Math.trunc(input.timeoutMs))),
    allowedDomains: normalizeDomainList(input.allowedDomains),
    blockedDomains: normalizeDomainList(input.blockedDomains),
  }
}

interface HtmlLinkMatch {
  index: number
  href: string
  innerHtml: string
}

function extractResultLinks(html: string): HtmlLinkMatch[] {
  const links: HtmlLinkMatch[] = []
  const anchorRegex = /<a(?:\s[^>]*)?>([\s\S]*?)<\/a>/gi

  for (const match of html.matchAll(anchorRegex)) {
    const tagHtml = match[0]
    const innerHtml = match[1] ?? ''
    const className = getHtmlAttribute(tagHtml, 'class')
    const href = getHtmlAttribute(tagHtml, 'href')
    if (!href || !hasAnyClass(className, RESULT_LINK_CLASS_NAMES)) {
      continue
    }

    links.push({
      index: match.index ?? 0,
      href,
      innerHtml,
    })
  }

  return links
}

function extractResultSnippet(resultHtml: string): string {
  const snippetRegex = /<(td|div|span)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi
  for (const match of resultHtml.matchAll(snippetRegex)) {
    const tagHtml = match[0]
    const className = getHtmlAttribute(tagHtml, 'class')
    if (hasAnyClass(className, RESULT_SNIPPET_CLASS_NAMES)) {
      return stripHtml(match[2] ?? '')
    }
  }

  return ''
}

function normalizeDuckDuckGoResultUrl(rawHref: string): string | null {
  const withProtocol = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref
  let url: URL
  try {
    url = new URL(withProtocol)
  }
  catch {
    return null
  }

  const redirected = url.hostname.endsWith('duckduckgo.com') ? url.searchParams.get('uddg') : null
  if (redirected) {
    try {
      url = new URL(redirected)
    }
    catch {
      return null
    }
  }

  return normalizeHttpUrl(url.toString())
}
