import { readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { escapeLiteralMarkers, projectBuddyUserText, sessionReferenceText } from '../../../shared/conversation/buddyUserReferenceText'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set(['的', '了', '是', '什么', '为什么', '怎么', '如何', '请', 'the', 'a', 'an', 'is', 'was', 'were', 'what', 'why', 'how', 'to', 'of', 'in', 'and'])

export function createSessionQuery(query = '') {
  const normalized = query.trim().toLocaleLowerCase()
  const terms = [...new Set([...segmenter.segment(normalized)].filter(part => part.isWordLike && !stopWords.has(part.segment)).map(part => part.segment))].slice(0, 24).toSorted((a, b) => b.length - a.length)
  return (text: string): number => {
    if (!normalized)
      return 0
    const lower = text.toLocaleLowerCase()
    const phrase = lower.indexOf(normalized)
    if (phrase >= 0)
      return phrase
    const matched = terms.find(term => lower.includes(term))
    return matched ? lower.indexOf(matched) : -1
  }
}

export function sessionMessageText(role: string, content: unknown): string {
  if (role === 'user') {
    const structured = readBuddyUserMessageContent(content)
    if (structured)
      return [projectBuddyUserText(structured.userContent), ...(structured.userContent.quotes ?? []).map(quote => escapeLiteralMarkers(quote.text)), sessionReferenceText(structured.userContent)].filter(Boolean).join('\n')
  }
  if (typeof content === 'string')
    return role === 'user' ? escapeLiteralMarkers(content) : content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>).text
    return typeof text === 'string' ? text : ''
  }
  return ''
}

export function sessionMessageReferences(role: string, content: unknown) {
  return role === 'user' ? readBuddyUserMessageContent(content)?.userContent.sessionReferences ?? [] : []
}

export function readSessionText(text: string, offset = 0, limit = 12000) {
  if (offset > text.length)
    throw new Error('SESSION_REFERENCE_OFFSET_OUT_OF_RANGE')
  const end = Math.min(text.length, offset + limit)
  return { text: text.slice(offset, end), offset, totalCharacters: text.length, nextOffset: end < text.length ? end : null }
}
