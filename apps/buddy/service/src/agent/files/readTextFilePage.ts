import type { ReadToolDetails } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { isTextMaterialBoundary, readTextMaterialPage } from '../../../../shared/conversation/textMaterialRead'

export function textFileReadStart(text: string, offset = 1, cursor = 0) {
  const line = Math.max(1, Math.trunc(offset))
  let start = 0
  for (let current = 1; current < line; current++) {
    const newline = text.indexOf('\n', start)
    if (newline === -1)
      throw new Error(`Offset ${offset} is beyond end of file`)
    start = newline + 1
  }
  const newline = text.indexOf('\n', start)
  const length = (newline === -1 ? text.length : newline) - start
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > length)
    throw new Error('READ_CURSOR_OUT_OF_RANGE')
  if (!isTextMaterialBoundary(text, start + cursor))
    throw new Error('READ_CURSOR_INSIDE_SURROGATE_PAIR')
  return { offset: line, cursor, position: start + cursor }
}

export function describeTextFilePage(text: string, start: ReturnType<typeof textFileReadStart>, limit: number | undefined, details: ReadToolDetails | undefined) {
  if (details?.truncation?.firstLineExceedsLimit) {
    const page = readTextMaterialPage(text, { offset: start.position, limit: DEFAULT_MAX_BYTES, maxBytes: DEFAULT_MAX_BYTES })
    return {
      text: page.text,
      metadata: {
        state: 'current' as const,
        range: page.range,
        complete: page.complete,
        next: page.complete ? null : { offset: start.offset, cursor: start.cursor + page.text.length },
      },
    }
  }
  const lines = details?.truncation?.truncated ? details.truncation.outputLines : limit
  let end = text.length
  let next: { offset: number, cursor: number } | null = null
  if (lines !== undefined) {
    let position = start.position
    for (let line = 0; line < lines; line++) {
      const newline = text.indexOf('\n', position)
      if (newline === -1)
        break
      position = newline + 1
      if (line + 1 === lines) {
        end = newline
        next = { offset: start.offset + lines, cursor: 0 }
      }
    }
  }
  return {
    metadata: {
      state: 'current' as const,
      range: { unit: 'utf16' as const, start: start.position, end },
      complete: next === null,
      next,
    },
  }
}
