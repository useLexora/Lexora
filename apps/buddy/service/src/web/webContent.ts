import type { WebResource } from '../../../shared/network/webTransport'
import { Buffer } from 'node:buffer'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { WebError } from '../../../shared/network/webProtocol'
import { requireWebSuccess } from '../../../shared/network/webTransport'

export interface WebDocument {
  url: string
  title: string
  content: string
  contentType: string
  acquisitionIncomplete: boolean
  warnings: string[]
  handler: 'html' | 'text' | 'pdf' | 'github'
  usage?: { credits: number, cost: null }
}

export function decodeWebText(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  }
  catch { return new TextDecoder().decode(bytes) }
}

export function extractHtml(html: string, url: string): WebDocument {
  const { document } = parseHTML(html)
  const title = document.title?.trim() || url
  const visible = document.body?.textContent?.trim() ?? ''
  if (document.querySelector('#challenge-form, #cf-challenge-running, form[action*="captcha"], #b_captcha')
    || /^(?:just a moment|access denied|verify you are human|security verification)/i.test(title)) {
    throw new WebError('WEB_CHALLENGE')
  }
  if (document.querySelector('input[type="password"]') && visible.length < 2000)
    throw new WebError('WEB_ACCESS_DENIED')
  const hasScripts = Boolean(document.querySelector('script'))
  for (const element of document.querySelectorAll('script, style, noscript, svg, iframe, form, nav, footer, header'))
    element.remove()
  for (const element of document.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      const raw = element.getAttribute(attribute)
      if (!raw)
        continue
      try {
        const target = new URL(raw, url)
        if (['http:', 'https:'].includes(target.protocol))
          element.setAttribute(attribute, target.href)
        else
          element.removeAttribute(attribute)
      }
      catch { element.removeAttribute(attribute) }
    }
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 120 }).parse()
  const source = article?.content || document.querySelector('main, article')?.innerHTML || document.body?.innerHTML || ''
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  markdown.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = parseHTML(`<html><body>${node.outerHTML}</body></html>`).document
      const rows: string[][] = [...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th, td')]
        .map(cell => (cell.textContent ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()))
      if (!rows.length)
        return ''
      const width = Math.max(...rows.map(row => row.length))
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`
      return `\n\n${[line(rows[0]!), line(Array.from<string>({ length: width }).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`
    },
  })
  const content = markdown.turndown(source).trim()
  if (content.length < 80 && hasScripts)
    throw new WebError('WEB_RENDER_REQUIRED')
  if (!content)
    throw new WebError('WEB_EMPTY_CONTENT')
  return { url, title: article?.title || title, content, contentType: 'text/markdown', acquisitionIncomplete: false, warnings: [], handler: 'html' }
}

export async function extractWebResource(resource: WebResource, signal: AbortSignal): Promise<WebDocument> {
  requireWebSuccess(resource.status)
  const type = resource.headers.get('content-type') ?? ''
  const mime = type.split(';')[0]!.trim().toLowerCase()
  const base = { url: resource.url, title: resource.url, acquisitionIncomplete: false, warnings: [] as string[] }
  if (mime === 'application/pdf' || Buffer.from(resource.bytes.subarray(0, 5)).toString() === '%PDF-') {
    const { getDocumentProxy } = await import('unpdf')
    signal.throwIfAborted()
    const pdf = await getDocumentProxy(Uint8Array.from(resource.bytes), { useSystemFonts: false, useWorkerFetch: false }).catch((error: unknown) => {
      signal.throwIfAborted()
      throw new WebError(error instanceof Error && error.name === 'PasswordException' ? 'WEB_ACCESS_DENIED' : 'WEB_UNSUPPORTED_CONTENT')
    })
    const cancel = () => {
      void pdf.loadingTask.destroy()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const pages: string[] = []
      let length = 0
      for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 200); pageNumber++) {
        signal.throwIfAborted()
        const page = await pdf.getPage(pageNumber)
        const text = await page.getTextContent()
        const content = text.items.flatMap(item => 'str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : []).join('').trim()
        length += content.length
        if (length > 4 * 1024 * 1024)
          break
        pages.push(`## Page ${pageNumber}\n\n${content || '[No extractable text on this page]'}`)
      }
      if (!pages.some(page => !page.endsWith('[No extractable text on this page]')))
        throw new WebError('WEB_UNSUPPORTED_CONTENT')
      return { ...base, content: pages.join('\n\n'), contentType: 'text/markdown', handler: 'pdf', acquisitionIncomplete: pages.length < pdf.numPages, warnings: ['PDF text order is best effort; no OCR was performed.'] }
    }
    catch (error) {
      signal.throwIfAborted()
      throw error instanceof WebError ? error : new WebError('WEB_UNSUPPORTED_CONTENT')
    }
    finally {
      signal.removeEventListener('abort', cancel)
      await pdf.loadingTask.destroy()
    }
  }
  const text = decodeWebText(resource.bytes, type)
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || (!mime && /^\s*(?:<!doctype html|<html)/i.test(text)))
    return extractHtml(text, resource.url)
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/ld+json'].includes(mime)) {
    if (!text.trim())
      throw new WebError('WEB_EMPTY_CONTENT')
    return { ...base, content: text, contentType: mime || 'text/plain', handler: 'text' }
  }
  throw new WebError('WEB_UNSUPPORTED_CONTENT')
}
