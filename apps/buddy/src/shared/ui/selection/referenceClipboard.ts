import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import { buddyResourceQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'

const references = new Map<string, { quote: BuddyResourceQuote, expires: number }>()
const lifetime = 24 * 60 * 60 * 1000

export async function copyReferenceClipboard(quote: BuddyResourceQuote, write: (text: string, html?: string) => Promise<void>): Promise<void> {
  const snapshot = buddyResourceQuoteSchema.parse(quote)
  const token = crypto.randomUUID()
  const block = document.createElement('blockquote')
  block.dataset.lexoraReference = token
  block.textContent = `${snapshot.source.title}\n${snapshot.text}`
  await write(block.textContent, block.outerHTML)
  const now = Date.now()
  for (const [id, entry] of references) {
    if (entry.expires <= now)
      references.delete(id)
  }
  references.set(token, { quote: snapshot, expires: now + lifetime })
  while (references.size > 64) references.delete(references.keys().next().value!)
}

export function readReferenceClipboard(html: string): BuddyResourceQuote | null {
  if (!html || html.length > 2 * 1024 * 1024)
    return null
  const document = new DOMParser().parseFromString(html, 'text/html')
  const blocks = document.querySelectorAll('blockquote[data-lexora-reference]')
  if (blocks.length !== 1)
    return null
  const token = blocks[0]!.getAttribute('data-lexora-reference')!
  const entry = references.get(token)
  if (!entry || entry.expires <= Date.now()) {
    references.delete(token)
    return null
  }
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
  const text = blocks[0]!.textContent ?? ''
  if (normalize(text) !== normalize(`${entry.quote.source.title}\n${entry.quote.text}`)
    || document.body.textContent?.trim() !== text.trim()) {
    return null
  }
  return structuredClone(entry.quote)
}
