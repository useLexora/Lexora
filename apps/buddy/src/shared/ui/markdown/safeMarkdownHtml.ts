import type { NodeRendererProps } from 'markstream-vue'
import type { ComputedRef, InjectionKey } from 'vue'
import type { MarkdownRemoteImagePolicy } from './markdownImage'
import DOMPurify from 'dompurify'

export type MarkdownImageSrcKind = 'remote-https' | 'remote-http' | 'local-protocol' | 'relative' | 'blocked'

export interface MarkdownHtmlPendingImage {
  element: HTMLImageElement
  src: string
  alt: string
}

export interface MarkdownHtmlRemoteImage {
  element: HTMLImageElement
  alt: string
}

export interface SanitizedMarkdownHtmlResult {
  fragment: DocumentFragment
  pendingImages: MarkdownHtmlPendingImage[]
  remoteImages: MarkdownHtmlRemoteImage[]
  hasContent: boolean
}

export interface MarkdownHtmlContext {
  allowImages: ComputedRef<boolean>
  remoteImages: ComputedRef<MarkdownRemoteImagePolicy>
  nestedRendererProps: ComputedRef<Partial<NodeRendererProps>>
}

export const markdownHtmlContextKey: InjectionKey<MarkdownHtmlContext> = Symbol('markdownHtmlContext')

const SAFE_BASE_HTML_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
] as const

const SAFE_IMAGE_HTML_TAGS = ['img', 'picture', 'source'] as const

const SAFE_BASE_TAG_SET = new Set<string>(SAFE_BASE_HTML_TAGS)
const SAFE_IMAGE_TAG_SET = new Set<string>(SAFE_IMAGE_HTML_TAGS)

const FORBIDDEN_HTML_TAGS = new Set<string>([
  'applet',
  'area',
  'audio',
  'base',
  'body',
  'button',
  'canvas',
  'datalist',
  'dialog',
  'embed',
  'fieldset',
  'form',
  'frame',
  'frameset',
  'head',
  'html',
  'iframe',
  'input',
  'label',
  'legend',
  'link',
  'map',
  'math',
  'meta',
  'noscript',
  'object',
  'optgroup',
  'option',
  'output',
  'portal',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'track',
  'video',
])

const VOID_HTML_TAGS = new Set<string>([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const SAFE_BASE_HTML_ATTRS = [
  'align',
  'cite',
  'colspan',
  'dir',
  'headers',
  'height',
  'href',
  'lang',
  'open',
  'rel',
  'reversed',
  'rowspan',
  'scope',
  'start',
  'target',
  'title',
  'type',
  'valign',
  'value',
  'width',
] as const

const SAFE_IMAGE_HTML_ATTRS = [
  'alt',
  'decoding',
  'loading',
  'media',
  'src',
] as const

const SAFE_BASE_ATTR_SET = new Set<string>(SAFE_BASE_HTML_ATTRS)
const SAFE_IMAGE_ATTR_SET = new Set<string>(SAFE_IMAGE_HTML_ATTRS)

const BOOLEAN_HTML_ATTRS = new Set<string>(['open', 'reversed'])
const SAFE_HREF_PROTOCOLS = new Set<string>(['http:', 'https:', 'mailto:', 'tel:'])
const SAFE_LOCAL_IMAGE_PROTOCOLS = new Set<string>(['lexora-attachment:', 'lexora-artifact:', 'lexora-file:'])

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code <= 31 || (code >= 127 && code <= 159))
      continue
    out += ch
  }
  return out
}

export function isAllowedMarkdownHtmlTag(tagName: string | undefined, allowImages: boolean): boolean {
  const normalized = tagName?.trim().toLowerCase() ?? ''
  if (!normalized)
    return false
  return SAFE_BASE_TAG_SET.has(normalized) || (allowImages && SAFE_IMAGE_TAG_SET.has(normalized))
}

export function isForbiddenMarkdownHtmlTag(tagName: string | undefined, allowImages: boolean): boolean {
  const normalized = tagName?.trim().toLowerCase() ?? ''
  if (!normalized)
    return false
  return FORBIDDEN_HTML_TAGS.has(normalized) || (!allowImages && SAFE_IMAGE_TAG_SET.has(normalized))
}

export function isSafeMarkdownHtmlHref(rawHref: string): boolean {
  const trimmed = rawHref.trim()
  if (!trimmed)
    return false
  const compact = stripControlChars(trimmed).replace(/\s+/g, '')
  if (!compact)
    return false
  if (compact.startsWith('//'))
    return false
  const protocolMatch = /^([a-z][a-z\d+.-]*:)/i.exec(compact)
  if (protocolMatch)
    return SAFE_HREF_PROTOCOLS.has(protocolMatch[1]!.toLowerCase())
  return true
}

export function classifyMarkdownImageSrc(rawSrc: string): MarkdownImageSrcKind {
  const trimmed = rawSrc.trim()
  if (!trimmed)
    return 'blocked'
  const compact = stripControlChars(trimmed).replace(/\s+/g, '')
  if (!compact || compact.startsWith('//'))
    return 'blocked'
  const protocolMatch = /^([a-z][a-z\d+.-]*:)/i.exec(compact)
  if (protocolMatch) {
    const protocol = protocolMatch[1]!.toLowerCase()
    if (protocol === 'https:')
      return 'remote-https'
    if (protocol === 'http:')
      return 'remote-http'
    if (SAFE_LOCAL_IMAGE_PROTOCOLS.has(protocol))
      return 'local-protocol'
    return 'blocked'
  }
  if (/^[#?/\\]/.test(trimmed))
    return 'blocked'
  return 'relative'
}

export function formatBlockedRemoteImageLabel(alt: string, language?: 'zh-CN' | 'en-US'): string {
  const cleanAlt = alt.trim()
  if (cleanAlt)
    return cleanAlt
  return language === 'en-US' ? 'External image' : '外链图片'
}

function createBlockedImageFallback(alt: string, language?: 'zh-CN' | 'en-US'): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'buddy-markdown-html-img-blocked'
  span.setAttribute('role', 'status')
  span.textContent = formatBlockedRemoteImageLabel(alt, language)
  return span
}

function findTagClose(source: string, start: number): number {
  let quote: '"' | '\'' | null = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === quote)
        quote = null
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (ch === '>')
      return i
  }
  return -1
}

function preprocessMarkdownHtml(raw: string, allowImages: boolean): string {
  const output: string[] = []
  const droppedStack: string[] = []
  let index = 0

  while (index < raw.length) {
    const lt = raw.indexOf('<', index)
    if (lt === -1) {
      if (droppedStack.length === 0)
        output.push(raw.slice(index))
      break
    }

    if (lt > index && droppedStack.length === 0)
      output.push(raw.slice(index, lt))

    if (raw.startsWith('<!--', lt)) {
      const commentEnd = raw.indexOf('-->', lt + 4)
      if (commentEnd === -1)
        break
      index = commentEnd + 3
      continue
    }

    const headMatch = /^<(\/?)([a-z][a-z\d:-]*)(?=[\s/>]|$)/i.exec(raw.slice(lt))
    if (!headMatch) {
      if (droppedStack.length === 0)
        output.push('&lt;')
      index = lt + 1
      continue
    }

    const close = findTagClose(raw, lt + headMatch[0].length)
    if (close === -1) {
      if (droppedStack.length === 0)
        output.push('&lt;')
      index = lt + 1
      continue
    }

    const token = raw.slice(lt, close + 1)
    const isClosing = headMatch[1] === '/'
    const tagName = headMatch[2]!.toLowerCase()
    const isSelfClosing = !isClosing && /\/\s*>$/.test(token)
    index = close + 1

    if (droppedStack.length > 0) {
      if (isClosing) {
        const matchIndex = droppedStack.lastIndexOf(tagName)
        if (matchIndex !== -1)
          droppedStack.splice(matchIndex)
      }
      else if (!isSelfClosing && !VOID_HTML_TAGS.has(tagName) && isForbiddenMarkdownHtmlTag(tagName, allowImages)) {
        droppedStack.push(tagName)
      }
      continue
    }

    if (isForbiddenMarkdownHtmlTag(tagName, allowImages)) {
      if (!isClosing && !isSelfClosing && !VOID_HTML_TAGS.has(tagName))
        droppedStack.push(tagName)
      continue
    }

    if (isAllowedMarkdownHtmlTag(tagName, allowImages)) {
      output.push(token)
      continue
    }

    output.push(escapeHtmlText(token))
  }

  return output.join('')
}

export function sanitizeMarkdownHtmlAttrs(
  attrs: readonly [string, string][] | null | undefined,
  tagName: string,
  options: { allowImages: boolean, remoteImages?: MarkdownRemoteImagePolicy },
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  if (!attrs?.length)
    return result

  const normalizedTag = tagName.trim().toLowerCase()
  const allowRemoteHttps = options.remoteImages === 'allow'
  let hasHref = false
  let targetBlank = false

  for (const [rawKey, rawValue] of attrs) {
    const key = rawKey.trim().toLowerCase()
    if (!key)
      continue
    const allowed = SAFE_BASE_ATTR_SET.has(key) || (options.allowImages && SAFE_IMAGE_ATTR_SET.has(key))
    if (!allowed)
      continue
    const value = String(rawValue ?? '')
    if (key === 'href') {
      if (normalizedTag !== 'a' || !isSafeMarkdownHtmlHref(value))
        continue
      hasHref = true
      result.href = value.trim()
      continue
    }
    if (key === 'target') {
      if (normalizedTag === 'a' && value.trim().toLowerCase() === '_blank') {
        targetBlank = true
        result.target = '_blank'
      }
      continue
    }
    if (key === 'rel') {
      if (normalizedTag === 'a')
        result.rel = value
      continue
    }
    if (key === 'src') {
      if (!options.allowImages || (normalizedTag !== 'img' && normalizedTag !== 'source'))
        continue
      if (allowRemoteHttps && classifyMarkdownImageSrc(value) === 'remote-https')
        result.src = value.trim()
      continue
    }
    if (BOOLEAN_HTML_ATTRS.has(key)) {
      result[key] = true
      continue
    }
    result[key] = value
  }

  if (normalizedTag === 'a') {
    if (!hasHref) {
      delete result.target
      delete result.rel
    }
    else if (targetBlank) {
      result.rel = 'noopener noreferrer'
    }
  }

  return result
}

export function sanitizeMarkdownHtmlFragment(
  rawHtml: string,
  options: { allowImages: boolean, remoteImages?: MarkdownRemoteImagePolicy, language?: 'zh-CN' | 'en-US' },
): SanitizedMarkdownHtmlResult {
  const empty = document.createDocumentFragment()
  if (!rawHtml)
    return { fragment: empty, pendingImages: [], remoteImages: [], hasContent: false }

  const preprocessed = preprocessMarkdownHtml(rawHtml, options.allowImages)
  if (!preprocessed)
    return { fragment: empty, pendingImages: [], remoteImages: [], hasContent: false }

  const allowedTags = options.allowImages
    ? [...SAFE_BASE_HTML_TAGS, ...SAFE_IMAGE_HTML_TAGS]
    : [...SAFE_BASE_HTML_TAGS]
  const allowedAttrs = options.allowImages
    ? [...SAFE_BASE_HTML_ATTRS, ...SAFE_IMAGE_HTML_ATTRS]
    : [...SAFE_BASE_HTML_ATTRS]

  const fragment = DOMPurify.sanitize(preprocessed, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttrs,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  })

  const allowRemoteHttps = options.remoteImages === 'allow'
  const pendingImages: MarkdownHtmlPendingImage[] = []
  const remoteImages: MarkdownHtmlRemoteImage[] = []

  for (const anchor of [...fragment.querySelectorAll('a')]) {
    const href = anchor.getAttribute('href')
    if (href !== null && !isSafeMarkdownHtmlHref(href))
      anchor.removeAttribute('href')

    const validHref = anchor.getAttribute('href')
    const target = anchor.getAttribute('target')?.trim().toLowerCase()
    if (!validHref) {
      anchor.removeAttribute('target')
      anchor.removeAttribute('rel')
    }
    else if (target === '_blank') {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
    }
    else {
      anchor.removeAttribute('target')
    }
  }

  for (const source of [...fragment.querySelectorAll('source')]) {
    if (!options.allowImages || !allowRemoteHttps) {
      source.remove()
      continue
    }
    const src = source.getAttribute('src')
    if (!src || classifyMarkdownImageSrc(src) !== 'remote-https')
      source.remove()
  }

  for (const image of [...fragment.querySelectorAll('img')]) {
    if (!options.allowImages) {
      image.remove()
      continue
    }
    const rawSrc = image.getAttribute('src')?.trim() ?? ''
    const alt = image.getAttribute('alt') ?? ''
    const kind = classifyMarkdownImageSrc(rawSrc)
    if (kind === 'blocked') {
      image.remove()
      continue
    }
    if (kind === 'remote-http' || (kind === 'remote-https' && !allowRemoteHttps)) {
      image.replaceWith(createBlockedImageFallback(alt, options.language))
      continue
    }
    image.classList.add('buddy-markdown-html-img')
    image.setAttribute('loading', 'lazy')
    image.setAttribute('decoding', 'async')
    if (kind === 'remote-https') {
      image.setAttribute('referrerpolicy', 'no-referrer')
      remoteImages.push({ element: image, alt })
      continue
    }
    if (kind === 'relative') {
      image.removeAttribute('src')
      pendingImages.push({
        element: image,
        src: rawSrc,
        alt,
      })
    }
  }

  const hasContent = fragment.childNodes.length > 0
    && (fragment.children.length > 0 || Boolean(fragment.textContent?.trim()))

  return { fragment, pendingImages, remoteImages, hasContent }
}
