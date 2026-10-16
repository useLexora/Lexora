import type { AgentWebSearchContextSize } from '@haohaoxue/lexora-contracts'
import { AGENT_WEB_SEARCH_CONTEXT_SIZE } from '@haohaoxue/lexora-contracts'

export interface ParsedWebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

export function getWebSearchSnippetMaxLength(contextSize: AgentWebSearchContextSize | undefined): number {
  if (contextSize === AGENT_WEB_SEARCH_CONTEXT_SIZE.LOW) {
    return 160
  }

  if (contextSize === AGENT_WEB_SEARCH_CONTEXT_SIZE.HIGH) {
    return 640
  }

  return 320
}

export function getHtmlAttribute(tagHtml: string, name: string): string | null {
  const attributeRegex = new RegExp(`\\s${name}=["']([^"']*)["']`, 'i')
  return tagHtml.match(attributeRegex)?.[1] ?? null
}

export function hasAnyClass(className: string | null, expected: Set<string>): boolean {
  if (!className) {
    return false
  }

  return className.split(/\s+/).some(item => expected.has(item))
}

export function getUrlSource(value: string): string | null {
  try {
    return normalizeDomain(new URL(value).hostname)
  }
  catch {
    return null
  }
}

export function normalizeHttpUrl(rawValue: string): string | null {
  const withProtocol = rawValue.startsWith('//') ? `https:${rawValue}` : rawValue

  let url: URL
  try {
    url = new URL(withProtocol)
  }
  catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  url.hash = ''
  return url.toString()
}

export function isDomainAllowed(
  source: string,
  allowedDomains: Set<string>,
  blockedDomains: Set<string>,
): boolean {
  if (matchesDomainSet(source, blockedDomains)) {
    return false
  }

  return allowedDomains.size === 0 || matchesDomainSet(source, allowedDomains)
}

export function normalizeDomainSet(domains: string[] | undefined): Set<string> {
  return new Set(normalizeDomainList(domains))
}

export function normalizeDomainList(domains: string[] | undefined): string[] {
  return [...new Set((domains ?? [])
    .map(normalizeDomain)
    .filter(Boolean))]
}

export function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&#x27;/g, '\'')
    .replace(/&#x2F;/g, '/')
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  if (maxLength <= 3) {
    return '.'.repeat(Math.max(0, maxLength))
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function matchesDomainSet(source: string, domains: Set<string>): boolean {
  for (const domain of domains) {
    if (source === domain || source.endsWith(`.${domain}`)) {
      return true
    }
  }

  return false
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '')
}
