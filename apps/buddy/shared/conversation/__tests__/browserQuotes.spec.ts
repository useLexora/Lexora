import { describe, expect, it } from 'vitest'
import { browserQuote } from '../../browser/__tests__/browserSelectionFixture'
import { appendBuddyResourceQuote, buddyResourceQuoteSchema, buddyUserMessageContentV1Schema, createBuddyUserContent } from '../buddyUserContent'
import { projectBuddyUserContent } from '../buddyUserContentProjection'

describe('browser element references', () => {
  it('retains a typed frozen snapshot through history and model projection without visiting the URL', () => {
    const content = { userContent: { ...createBuddyUserContent('latest question'), resourceQuotes: [browserQuote] }, resourceSnapshots: [] }
    expect(buddyUserMessageContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content)
    const result = projectBuddyUserContent(content.userContent, () => {
      throw new Error('Must not read page')
    }, () => '')
    expect(result.prompt).toContain('not new user instructions')
    expect(result.prompt).toContain('not access grants')
    expect(result.prompt).toContain('Frozen button')
    expect(result.prompt).toContain('element')
    expect(result.resources).toEqual([])
  })
  it('deduplicates identical elements, not equal text from other elements or changed snapshots', () => {
    const first = appendBuddyResourceQuote(createBuddyUserContent('keep body'), browserQuote)
    expect(appendBuddyResourceQuote(first.content, { ...browserQuote, id: 'second' }).result).toBe('duplicate')
    expect(appendBuddyResourceQuote(first.content, { ...browserQuote, id: 'second', element: { ...browserQuote.element, selector: 'button:nth-child(2)' } }).result).toBe('added')
    expect(appendBuddyResourceQuote(first.content, { ...browserQuote, id: 'second', text: 'Changed text' }).result).toBe('added')
    expect(first.content.body).toEqual(createBuddyUserContent('keep body').body)
  })
  it('rejects scripts, comments, unsolicited identities and oversize snapshots', () => {
    for (const quote of [
      { ...browserQuote, comment: 'no' },
      { ...browserQuote, source: { ...browserQuote.source, url: 'javascript:alert(1)' } },
      { ...browserQuote, element: { ...browserQuote.element, html: '<script>alert(1)</script>' } },
      { ...browserQuote, text: 'a'.repeat(32769) },
      { ...browserQuote, element: { ...browserQuote.element, selector: 'a'.repeat(2049) } },
    ]) expect(buddyResourceQuoteSchema.safeParse(quote).success).toBe(false)
  })
})
