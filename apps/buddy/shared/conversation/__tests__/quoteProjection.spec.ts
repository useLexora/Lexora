import type { BuddyMessageQuote, BuddyViewQuote } from '../buddyUserContent'
import { describe, expect, it } from 'vitest'
import { BUDDY_QUOTE_INLINE_TEXT_LIMIT, BUDDY_QUOTE_INLINE_TOTAL_LIMIT, projectBuddyQuoteText } from '../buddyResourceQuoteText'
import { buddyUserContentV1Schema, createBuddyUserContent } from '../buddyUserContent'

const message: BuddyMessageQuote = { id: 'same-id', text: '  保留当时的文字\n', source: { conversationId: 'source-task', branchId: 'source-branch', messageId: 'original-message', role: 'assistant', runId: null } }
const view: BuddyViewQuote = { id: 'same-id', text: '当时选中的段落', source: { kind: 'view', title: '测试文档', provider: 'extension:tests.office', target: { extensionId: 'tests.office', privateTarget: 'hidden-target' } }, locator: { version: 1, data: { secret: 'hidden-locator' } } }
const entries = (prompt: string) => prompt.split('\n').filter(line => line.startsWith('[')).flatMap(line => JSON.parse(line))

describe('reference context projection', () => {
  it('keeps short text inline with stable and distinct identities and no retrieval round trip', () => {
    const prompt = projectBuddyQuoteText({ quotes: [message], resourceQuotes: [view] }, { sourceMessageId: 'carrying-message' })
    expect(entries(prompt)).toMatchObject([
      { referenceId: message.id, kind: 'message', sourceMessageId: 'carrying-message', text: message.text },
      { referenceId: view.id, kind: 'resource', sourceMessageId: 'carrying-message', text: view.text },
    ])
    expect(prompt).not.toContain('lexora_reference_read')
    expect(prompt).not.toContain('hidden-target')
    expect(prompt).not.toContain('hidden-locator')
  })

  it('accepts and preserves a long snapshot but projects only a preview and its read identity', () => {
    const text = `${'中文选区'.repeat(18000)}正文末尾不可从预览猜到`
    const content = buddyUserContentV1Schema.parse({ ...createBuddyUserContent('请阅读末尾'), resourceQuotes: [{ ...view, text }] })
    const prompt = projectBuddyQuoteText(content, { sourceMessageId: 'carrying-message' })
    expect(content.resourceQuotes![0]!.text).toBe(text)
    expect(entries(prompt)).toMatchObject([{ referenceId: view.id, kind: 'resource', sourceMessageId: 'carrying-message', textLength: text.length, truncated: true }])
    expect(entries(prompt)[0]).not.toHaveProperty('text')
    expect(prompt).not.toContain('正文末尾不可从预览猜到')
    expect(prompt).toContain('lexora_reference_read')
    expect(prompt.length).toBeLessThan(2500)
  })

  it('shares the inline budget across message and resource quotes without dropping any reference', () => {
    const text = '短'.repeat(BUDDY_QUOTE_INLINE_TEXT_LIMIT - 100)
    const content = {
      quotes: Array.from({ length: 4 }, (_, i) => ({ ...message, id: `message-${i}`, text })),
      resourceQuotes: Array.from({ length: 4 }, (_, i) => ({ ...view, id: `resource-${i}`, text })),
    }
    const projected = entries(projectBuddyQuoteText(content, { sourceMessageId: 'carrying-message' }))
    expect(projected).toHaveLength(8)
    expect(projected.some(item => item.truncated)).toBe(true)
    expect(projected.reduce((sum, item) => sum + (item.text?.length ?? 0), 0)).toBeLessThanOrEqual(BUDDY_QUOTE_INLINE_TOTAL_LIMIT)
    expect(projected.every(item => item.sourceMessageId === 'carrying-message')).toBe(true)
  })

  it('keeps bounded full snapshots without tools and rejects oversized input instead of hiding content', () => {
    const text = '只读全文'.repeat(600)
    const prompt = projectBuddyQuoteText({ resourceQuotes: [{ ...view, text }] }, { sourceMessageId: 'carrying-message', readAvailable: false })
    expect(entries(prompt)[0].text).toBe(text)
    expect(prompt).not.toContain('lexora_reference_read')
    expect(() => projectBuddyQuoteText({ resourceQuotes: [{ ...view, text: '大'.repeat(10000) }] }, { readAvailable: false })).toThrow('MODEL_INPUT_TOO_LARGE')
  })
})
