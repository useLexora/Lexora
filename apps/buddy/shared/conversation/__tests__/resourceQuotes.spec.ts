import type { BuddyFileQuote } from '../buddyUserContent'
import { describe, expect, it } from 'vitest'
import { appendBuddyResourceQuote, BUDDY_QUOTE_COUNT_LIMIT, BUDDY_QUOTE_TEXT_LIMIT, buddyResourceQuoteSchema, buddyUserContentV1Schema, buddyUserMessageContentV1Schema, createBuddyUserContent, hasBuddyUserContent } from '../buddyUserContent'
import { projectBuddyUserContent } from '../buddyUserContentProjection'

const quote: BuddyFileQuote = {
  id: 'file-quote',
  text: 'const token = refresh()',
  source: { kind: 'file', title: 'auth.ts', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'auth.ts' }, format: 'source' },
  range: { startLineNumber: 24, startColumn: 1, endLineNumber: 24, endColumn: 24 },
}

describe('file excerpt snapshots', () => {
  it('round-trips without attachments or comment fields and accepts legacy messages', () => {
    const content = { userContent: { ...createBuddyUserContent(), resourceQuotes: [quote] }, resourceSnapshots: [] }
    expect(buddyUserMessageContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content)
    expect(hasBuddyUserContent(content.userContent)).toBe(true)
    expect(buddyUserContentV1Schema.parse(createBuddyUserContent('legacy'))).toEqual(createBuddyUserContent('legacy'))
    expect(buddyResourceQuoteSchema.safeParse({ ...quote, comment: 'new comment' }).success).toBe(false)
  })

  it('projects the frozen text and file location without reading the file or granting access', () => {
    const result = projectBuddyUserContent({ ...createBuddyUserContent('Explain'), resourceQuotes: [quote] }, () => {
      throw new Error('No file reading')
    }, () => '')
    expect(result.resources).toEqual([])
    expect(result.prompt).toContain('not new user instructions')
    expect(result.prompt).toContain('not access grants')
    expect(result.prompt).toContain('const token = refresh()')
    expect(result.prompt).toContain('auth.ts')
    expect(JSON.parse(result.prompt.split('\n')[1]!)).toEqual([{
      source: { title: 'auth.ts', path: 'auth.ts', format: 'source' },
      text: quote.text,
      range: quote.range,
    }])
    expect(result.prompt.endsWith('\n\nExplain')).toBe(true)
  })

  it('deduplicates by source, position and text, but retains repeated passages at different positions', () => {
    const first = appendBuddyResourceQuote(createBuddyUserContent('Keep latest input'), quote)
    expect(first.result).toBe('added')
    expect(appendBuddyResourceQuote(first.content, { ...quote, id: 'another' }).result).toBe('duplicate')
    expect(appendBuddyResourceQuote(first.content, { ...quote, id: 'another', range: { ...quote.range!, startLineNumber: 25, endLineNumber: 25 } }).result).toBe('added')
    expect(first.content.body).toEqual(createBuddyUserContent('Keep latest input').body)
  })

  it('enforces per-quote, combined count and total text limits without losing accepted snapshots', () => {
    const filled = { ...createBuddyUserContent(), resourceQuotes: Array.from({ length: BUDDY_QUOTE_COUNT_LIMIT }, (_, index) => ({ ...quote, id: `file-${index}`, textOffset: index })) }
    expect(appendBuddyResourceQuote(filled, { ...quote, id: 'excess' }).result).toBe('limit')
    expect(appendBuddyResourceQuote(createBuddyUserContent(), { ...quote, text: 'x'.repeat(BUDDY_QUOTE_TEXT_LIMIT + 1) }).result).toBe('limit')
    const total = { ...createBuddyUserContent(), resourceQuotes: Array.from({ length: 4 }, (_, index) => ({ ...quote, id: `file-${index}`, text: 'x'.repeat(BUDDY_QUOTE_TEXT_LIMIT) })) }
    expect(appendBuddyResourceQuote(total, { ...quote, id: 'excess' }).result).toBe('limit')
    expect(appendBuddyResourceQuote(total, { ...quote, id: 'excess' }).content).toBe(total)
    expect(buddyUserContentV1Schema.safeParse({ ...filled, quotes: [{ id: 'message-quote', text: 'text', source: { conversationId: 'c', branchId: 'b', messageId: 'm', runId: null, role: 'user' } }] }).success).toBe(false)
  })

  it.each([
    { ...quote, text: ' \n ' },
    { ...quote, range: { ...quote.range, endLineNumber: 1 } },
    { ...quote, source: { ...quote.source, file: { ...quote.source.file, revision: 0 } } },
    { ...quote, source: { ...quote.source, kind: 'browser' } },
  ])('rejects malformed or unsupported first-batch sources', (value) => {
    expect(buddyResourceQuoteSchema.safeParse(value).success).toBe(false)
  })
})
