import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { UserQuestionRequest } from '@buddy-shared/questions/userQuestionApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, shallowRef } from 'vue'
import { createUserQuestionInteractionState, useUserQuestions } from '../useUserQuestions'

const now = '2026-11-03T00:00:00.000Z'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function request(id: string, conversationId = 'task'): UserQuestionRequest {
  return { id, conversationId, branchId: 'branch', runId: id, rootRunId: id, buddyName: 'Lexora', questions: [{ id: 'scope', question: '验证范围？', kind: 'text', options: [] }], status: 'pending', response: null, createdAt: now, resolvedAt: null }
}
function setup(overrides: Partial<LocalChatApi['questions']> = {}, interaction = createUserQuestionInteractionState()) {
  const api: LocalChatApi['questions'] = {
    retry: async input => request(input.requestId),
    list: async () => [request('first'), request('second')],
    answer: async input => ({ ...request(input.requestId, input.conversationId), status: 'answered', response: { answers: input.answers }, resolvedAt: now }),
    cancel: async input => ({ ...request(input.requestId, input.conversationId), status: 'cancelled', resolvedAt: now }),
    onChanged: () => () => {},
    ...overrides,
  }
  const conversationId = shallowRef<string | null>('task')
  const branchId = shallowRef<string | null>('branch')
  const ready = shallowRef(true)
  const scope = effectScope()
  const state = scope.run(() => useUserQuestions({ interaction, api, conversationId, branchId, ready }))!
  cleanups.push(() => scope.stop())
  return { state, conversationId, branchId, api, dispose: () => scope.stop() }
}
const answer = (text: string) => ({ questionId: 'scope', selectedOptionIds: [], text })

describe('task-owned user questions', () => {
  it('keeps the selected request across workspace release and advances when it closes', async () => {
    const interaction = createUserQuestionInteractionState()
    const first = setup({}, interaction)
    await vi.waitFor(() => expect(first.state.selected.value?.id).toBe('first'))
    first.state.select('second')
    first.state.updateAnswer('second', answer('Saved second draft'))
    first.dispose()
    const reopened = setup({}, interaction)
    await vi.waitFor(() => expect(reopened.state.selected.value?.id).toBe('second'))
    expect(reopened.state.drafts.value.get('second')?.[0]?.text).toBe('Saved second draft')
    expect(await reopened.state.resolve('second', true)).toBe(true)
    expect(reopened.state.selected.value?.id).toBe('first')
    expect(reopened.state.drafts.value.get('first')?.[0]?.text).toBe('')
  })

  it('preserves the active question and all drafts across switching and workspace release, then submits the complete group', async () => {
    const interaction = createUserQuestionInteractionState()
    const group: UserQuestionRequest = { ...request('first'), questions: [request('first').questions[0]!, { id: 'constraints', question: '还需要遵守什么限制？', kind: 'text', options: [] }] }
    const api: Partial<LocalChatApi['questions']> = {
      list: async () => [group, request('second')],
      answer: async input => ({ ...group, status: 'answered', response: { answers: structuredClone(input.answers) }, resolvedAt: now }),
    }
    const first = setup(api, interaction)
    await vi.waitFor(() => expect(first.state.pending.value).toHaveLength(2))
    first.state.updateAnswer('first', answer('只做隔离验证。'))
    first.state.selectQuestion('first', 'constraints')
    first.state.updateAnswer('first', { questionId: 'constraints', selectedOptionIds: [], text: '不修改实际用户数据。' })
    first.state.selectQuestion('first', 'missing')
    first.state.selectQuestion('second', 'constraints')
    expect(first.state.selectedQuestionIds.value.get('first')).toBe('constraints')
    expect(first.state.selectedQuestionIds.value.get('second')).toBe('scope')
    first.dispose()
    const reopened = setup(api, interaction)
    await vi.waitFor(() => expect(reopened.state.pending.value).toHaveLength(2))
    expect(reopened.state.selectedQuestionIds.value.get('first')).toBe('constraints')
    expect(reopened.state.drafts.value.get('first')?.map(value => value.text)).toEqual(['只做隔离验证。', '不修改实际用户数据。'])
    expect(await reopened.state.resolve('first', true)).toBe(true)
    expect(reopened.state.history.value[0]?.entries.map(value => value.answer)).toEqual(['只做隔离验证。', '不修改实际用户数据。'])
    expect(reopened.state.selectedQuestionIds.value.has('first')).toBe(false)
    expect(reopened.state.selectedQuestionIds.value.get('second')).toBe('scope')
  })

  it('restores a pending draft when its task workspace is released and reopened', async () => {
    const interaction = createUserQuestionInteractionState()
    const first = setup({}, interaction)
    await vi.waitFor(() => expect(first.state.pending.value).toHaveLength(2))
    first.state.updateAnswer('first', answer('keep across workspace release'))
    first.state.toggleExpanded('first')
    first.dispose()
    const reopened = setup({}, interaction)
    await vi.waitFor(() => expect(reopened.state.pending.value).toHaveLength(2))
    expect(reopened.state.drafts.value.get('first')?.[0]?.text).toBe('keep across workspace release')
    expect(reopened.state.expandedIds.value.has('first')).toBe(false)
  })

  it('submits each request independently and sends cloneable answers across IPC', async () => {
    const first = deferred<UserQuestionRequest>()
    const f = setup({ answer: async (input) => {
      const copy = structuredClone(input)
      return input.requestId === 'first' ? first.promise : { ...request('second'), status: 'answered', response: { answers: copy.answers } }
    } })
    await vi.waitFor(() => expect(f.state.pending.value).toHaveLength(2))
    f.state.updateAnswer('first', answer('first draft'))
    f.state.updateAnswer('second', reactive(answer('second draft')))
    const submitting = f.state.resolve('first', true)
    expect(f.state.resolvingIds.value.has('first')).toBe(true)
    expect(await f.state.resolve('second', true)).toBe(true)
    expect(f.state.pending.value.map(item => item.id)).toEqual(['first'])
    expect(f.state.history.value[0]?.entries[0]?.answer).toBe('second draft')
    first.resolve({ ...request('first'), status: 'answered', response: { answers: [answer('first draft')] } })
    expect(await submitting).toBe(true)
    expect(f.state.pending.value).toHaveLength(0)
  })

  it('retains drafts and expansion across scope changes, rejecting late results from another task', async () => {
    const late = deferred<UserQuestionRequest>()
    const f = setup({ list: async input => [request(input.conversationId, input.conversationId)], answer: async () => late.promise })
    await vi.waitFor(() => expect(f.state.pending.value[0]?.id).toBe('task'))
    f.state.updateAnswer('task', answer('keep this draft'))
    f.state.toggleExpanded('task')
    const submitting = f.state.resolve('task', true)
    f.conversationId.value = 'other'
    await vi.waitFor(() => expect(f.state.pending.value[0]?.id).toBe('other'))
    f.state.updateAnswer('other', answer('other draft'))
    late.resolve({ ...request('task'), status: 'answered' })
    await submitting
    expect(f.state.pending.value[0]?.id).toBe('other')
    expect(f.state.drafts.value.get('other')?.[0]?.text).toBe('other draft')
    f.conversationId.value = 'task'
    await vi.waitFor(() => expect(f.state.pending.value[0]?.id).toBe('task'))
    expect(f.state.drafts.value.get('task')?.[0]?.text).toBe('keep this draft')
    expect(f.state.expandedIds.value.has('task')).toBe(false)
  })

  it('isolates a submission failure without losing drafts or blocking other questions', async () => {
    const f = setup({ answer: async () => {
      throw new Error('offline')
    } })
    await vi.waitFor(() => expect(f.state.pending.value).toHaveLength(2))
    f.state.updateAnswer('first', answer('retry me'))
    expect(await f.state.resolve('first', true)).toBe(false)
    expect(f.state.errors.value).toEqual(new Set(['first']))
    expect(f.state.drafts.value.get('first')?.[0]?.text).toBe('retry me')
    expect(await f.state.resolve('second', false)).toBe(true)
    expect(f.state.pending.value.map(item => item.id)).toEqual(['first'])
  })

  it('ignores a stale list after a submission and a branch change', async () => {
    const stale = deferred<UserQuestionRequest[]>()
    const f = setup()
    await vi.waitFor(() => expect(f.state.pending.value).toHaveLength(2))
    f.api.list = async () => stale.promise
    const refreshing = f.state.refresh()
    expect(await f.state.resolve('first', false)).toBe(true)
    stale.resolve([request('first'), request('second')])
    await refreshing
    expect(f.state.pending.value.map(item => item.id)).toEqual(['second'])
    const oldBranch = deferred<UserQuestionRequest[]>()
    f.api.list = async input => input.branchId === 'branch' ? oldBranch.promise : []
    const previous = f.state.refresh()
    f.branchId.value = 'another'
    await nextTick()
    oldBranch.resolve([request('first')])
    await previous
    expect(f.state.records.value).toEqual([])
  })

  it.each([true, false])('retains a concurrent new question when a submission finishes first, answer=%s', async (submitAnswer) => {
    const acknowledgement = deferred<UserQuestionRequest>()
    const snapshot = deferred<UserQuestionRequest[]>()
    const f = setup({ list: async () => [request('first')], answer: async () => acknowledgement.promise, cancel: async () => acknowledgement.promise })
    await vi.waitFor(() => expect(f.state.pending.value).toHaveLength(1))
    f.state.updateAnswer('first', answer('accepted'))
    const submitting = f.state.resolve('first', submitAnswer)
    f.api.list = async () => snapshot.promise
    const refreshing = f.state.refresh()
    acknowledgement.resolve({ ...request('first'), status: submitAnswer ? 'answered' : 'cancelled', response: submitAnswer ? { answers: [answer('accepted')] } : null })
    expect(await submitting).toBe(true)
    snapshot.resolve([request('first'), request('second')])
    await refreshing
    expect(f.state.pending.value.map(item => item.id)).toEqual(['second'])
    expect(f.state.selected.value?.id).toBe('second')
    expect(f.state.records.value[0]?.status).toBe(submitAnswer ? 'answered' : 'cancelled')
    expect(f.state.drafts.value.has('first')).toBe(false)
    expect(f.state.drafts.value.get('second')).toEqual([answer('')])
  })

  it('preserves completed delivery when the earlier submission acknowledgement arrives last', async () => {
    const acknowledgement = deferred<UserQuestionRequest>()
    const f = setup({ answer: async () => acknowledgement.promise })
    await vi.waitFor(() => expect(f.state.pending.value).toHaveLength(2))
    f.state.updateAnswer('first', answer('accepted'))
    const submitting = f.state.resolve('first', true)
    const answered: UserQuestionRequest = { ...request('first'), status: 'answered', response: { answers: [answer('accepted')] }, delivery: { state: 'delivered', targetRunId: 'continuation' } }
    f.api.list = async () => [answered, request('second')]
    await f.state.refresh()
    acknowledgement.resolve({ ...answered, delivery: { state: 'pending', targetRunId: null } })
    await submitting
    expect(f.state.records.value[0]).toEqual(answered)
    expect(f.state.history.value[0]?.delivery?.state).toBe('delivered')
  })
})
