import { describe, expect, it } from 'vitest'
import { resourceQuoteText } from '../buddyResourceQuoteText'
import { appendBuddyResourceQuote, buddyResourceQuoteSchema, buddyUserContentV1Schema, createBuddyUserContent } from '../buddyUserContent'
import { referenceJsonSchema, sameReferenceJson } from '../referenceMaterial'

const quote = {
  id: 'reference-1',
  text: 'Amount: 42',
  source: { kind: 'view' as const, title: 'Report', provider: 'extension:local.reader', target: { viewType: 'local.reader.report' } },
  locator: { version: 1, data: { sheet: 'Summary', cells: 'A1:B2' } },
}

describe('view reference materials', () => {
  it('preserves a frozen snapshot and opaque navigation independently through serialization', () => {
    const added = appendBuddyResourceQuote(createBuddyUserContent('Review this'), quote)
    expect(added.result).toBe('added')
    const restored = buddyUserContentV1Schema.parse(JSON.parse(JSON.stringify(added.content)))
    expect(restored.resourceQuotes).toEqual([quote])
    const modelText = resourceQuoteText(restored.resourceQuotes)
    expect(modelText).toContain('Amount: 42')
    expect(modelText).toContain('extension:local.reader')
    expect(modelText).not.toContain('A1:B2')
    expect(modelText).not.toContain('viewType')
  })

  it('owns navigation snapshots independently of the mutable caller', () => {
    const input = { page: { cells: ['A1', 'B2'] } }
    const snapshot = referenceJsonSchema.parse(input)
    input.page.cells.push('C3')
    expect(snapshot).toEqual({ page: { cells: ['A1', 'B2'] } })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen((snapshot as typeof input).page.cells)).toBe(true)
  })

  it('distinguishes content, provider, target and locator while deduplicating repeated clicks', () => {
    const content = appendBuddyResourceQuote(createBuddyUserContent(), quote).content
    expect(appendBuddyResourceQuote(content, { ...quote, id: 'duplicate' }).result).toBe('duplicate')
    for (const changed of [
      { ...quote, text: 'Amount: 43' },
      { ...quote, source: { ...quote.source, provider: 'extension:local.other' } },
      { ...quote, source: { ...quote.source, target: { viewType: 'local.reader.other' } } },
      { ...quote, locator: { version: 2, data: quote.locator.data } },
    ]) {
      expect(appendBuddyResourceQuote(content, { ...changed, id: 'distinct' }).result).toBe('added')
    }
  })

  it('rejects executable, cyclic, sparse and oversized navigation without invoking accessors', () => {
    let accessed = false
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() {
      accessed = true
      return 'secret'
    } })
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    for (const value of [undefined, new Date(), { fn() {} }, { value: Infinity }, accessor, cycle, Array.from({ length: 2 }), 'a'.repeat(8193), Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), i]))]) {
      expect(referenceJsonSchema.safeParse(value).success).toBe(false)
    }
    expect(accessed).toBe(false)
    let deep: unknown = null
    for (let i = 0; i < 14; i++) deep = { child: deep }
    expect(referenceJsonSchema.safeParse(deep).success).toBe(false)
    expect(buddyResourceQuoteSchema.safeParse({ ...quote, locator: { version: 0, data: null } }).success).toBe(false)
  })
})

it('compares JSON objects without key order while retaining array and primitive identity', () => {
  const first = { ...quote, source: { ...quote.source, target: { viewType: 'reader', options: { a: 1, b: [false, null] } } } }
  const second = { ...first, id: 'reordered', source: { ...first.source, target: { options: { b: [false, null], a: 1 }, viewType: 'reader' } }, locator: { data: { cells: 'A1:B2', sheet: 'Summary' }, version: 1 } }
  const content = appendBuddyResourceQuote(createBuddyUserContent(), first).content
  expect(appendBuddyResourceQuote(content, second).result).toBe('duplicate')
  for (const [left, right] of [[[1, 2], [2, 1]], [[], {}], [null, false], [0, false], [{ a: null }, { b: null }], [{ a: 1 }, { a: 1, b: 2 }], [undefined, null]] as const)
    expect(sameReferenceJson(left, right)).toBe(false)
})
