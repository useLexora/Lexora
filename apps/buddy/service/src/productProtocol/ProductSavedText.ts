import type { ProductReadSavedTextInput } from '../../../shared/productProtocol/messageText'
import { createHash } from 'node:crypto'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { LIVE_TEXT_WINDOW_UNITS } from '../../../shared/productProtocol/messageText'

const savedVersion = (text: string) => `s:${createHash('sha256').update(text, 'utf16le').digest('hex')}`
function splitsPair(text: string, index: number) {
  return index > 0 && index < text.length && (text.charCodeAt(index - 1) & 0xFC00) === 0xD800 && (text.charCodeAt(index) & 0xFC00) === 0xDC00
}
export function savedTextTail(text: string, size: number) {
  const from = Math.max(0, text.length - size)
  const start = splitsPair(text, from) ? from + 1 : from
  return { text: text.slice(start), range: { revision: savedVersion(text), start, end: text.length, total: text.length } }
}
export function readSavedTextPage(text: string, { revision, direction, offset }: Pick<ProductReadSavedTextInput, 'revision' | 'direction' | 'offset'>) {
  if (savedVersion(text) !== revision)
    throw new ProductProtocolError('SOURCE_CHANGED')
  if (offset > text.length)
    throw new ProductProtocolError('INVALID_PARAMS')
  const anchor = splitsPair(text, offset) ? offset - 1 : offset
  let start = direction === 'after' ? anchor : Math.max(0, anchor - LIVE_TEXT_WINDOW_UNITS)
  let end = direction === 'before' ? anchor : Math.min(text.length, anchor + LIVE_TEXT_WINDOW_UNITS)
  if (splitsPair(text, start))
    start++
  if (splitsPair(text, end))
    end--
  return { text: text.slice(start, end), range: { revision, start, end, total: text.length } }
}
