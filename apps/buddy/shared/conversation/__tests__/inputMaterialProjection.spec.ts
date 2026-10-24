import { describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../buddyUserContent'
import { projectBuddyUserContent } from '../buddyUserContentProjection'
import { InputMaterialProjectionBudget } from '../inputMaterialProjection'

describe('shared input material projection', () => {
  it('shares a byte budget across quotes and text attachments without changing saved text', () => {
    const text = '文'.repeat(1000)
    const content = { ...createBuddyUserContent('Compare'), panelResourceIds: ['file'], quotes: [{ id: 'quote', text, source: { conversationId: 'task', branchId: 'branch', messageId: 'original', role: 'assistant' as const, runId: null } }] }
    const projected = projectBuddyUserContent(content, () => ({ kind: 'text', name: 'saved.txt', text }), () => '', { sourceMessageId: 'carrying', budget: new InputMaterialProjectionBudget(4000) })
    expect(projected.materialProjection).toEqual({ deferredReferences: false, deferredResourceIds: ['file'] })
    expect(projected.prompt).toContain('"sourceMessageId":"carrying","referenceId":"file","kind":"attachment"')
    expect(projected.prompt.match(new RegExp(text, 'g'))).toHaveLength(1)
    expect(content.quotes[0]!.text).toBe(text)
  })

  it('uses bounded full text with no tools, and rejects an inaccessible omitted body', () => {
    const budget = new InputMaterialProjectionBudget(10000)
    expect(budget.project('a'.repeat(4000), false)).toEqual({ text: 'a'.repeat(4000), deferred: false })
    expect(() => budget.project('b'.repeat(6001), false)).toThrow('MODEL_INPUT_TOO_LARGE')
    expect(() => projectBuddyUserContent({ ...createBuddyUserContent(), panelResourceIds: ['file'] }, () => ({ kind: 'text', name: 'data.txt', text: 'a'.repeat(20000) }), () => '')).toThrow('MODEL_INPUT_TOO_LARGE')
  })

  it('bounds previews without splitting Unicode and preserves identities when the budget is exhausted', () => {
    const budget = new InputMaterialProjectionBudget(6)
    expect(budget.project('😀'.repeat(2000), true)).toEqual({ text: '😀', deferred: true })
    expect(budget.project('next', true)).toEqual({ text: '', deferred: true })
  })
})
