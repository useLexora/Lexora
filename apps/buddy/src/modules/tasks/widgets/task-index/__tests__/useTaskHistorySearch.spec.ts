import type { LocalConversationHistoryPage } from '@buddy-shared/conversation/conversationHistoryApi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useTaskHistorySearch } from '../useTaskHistorySearch'

const scopes: ReturnType<typeof effectScope>[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
})

function page(id: string, nextCursor: string | null = null): LocalConversationHistoryPage {
  return {
    items: [{
      conversation: { id, title: id, buddyId: 'default', activeBranchId: null, approvalPolicy: 'policy', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', deletedAt: null, executionProfile: 'workspace_write', spaceId: null, activity: 'idle', modelSelection: null, automationOccurrence: null },
      markState: { conversationId: id, markId: null, resultRunId: null, unread: false, readRevision: 0 },
    }],
    nextCursor,
  }
}

function deferred() {
  let resolve!: (page: LocalConversationHistoryPage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<LocalConversationHistoryPage>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

function create(search: (query: string, cursor?: string) => Promise<LocalConversationHistoryPage>) {
  const scope = effectScope()
  scopes.push(scope)
  const show = shallowRef(true)
  const errors: string[] = []
  const history = scope.run(() => useTaskHistorySearch({ show: () => show.value, search, onError: () => errors.push('failed') }))!
  return { ...history, show, errors, scope }
}

describe('all-history search', () => {
  it('debounces all-history requests and invalidates old responses before the next debounce expires', async () => {
    const requests: string[] = []
    const first = deferred()
    const second = deferred()
    const state = create((query) => {
      requests.push(query)
      return query === 'old' ? first.promise : second.promise
    })
    state.query.value = 'o'
    await vi.advanceTimersByTimeAsync(100)
    state.query.value = 'old'
    await vi.advanceTimersByTimeAsync(220)
    expect(requests).toEqual(['old'])
    state.query.value = 'new'
    first.resolve(page('old-result'))
    await Promise.resolve()
    expect(state.items.value).toEqual([])
    expect(state.loading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(220)
    second.resolve(page('unloaded-task'))
    await Promise.resolve()
    expect(state.items.value[0]?.conversation.id).toBe('unloaded-task')
    expect(state.loading.value).toBe(false)
  })

  it('appends cursor pages, deduplicates IDs and retains results and cursor on retryable failure', async () => {
    let failure = true
    const requests: (string | undefined)[] = []
    const state = create(async (_, cursor) => {
      requests.push(cursor)
      if (!cursor)
        return page('first', 'cursor-a')
      if (failure)
        throw new Error('unavailable')
      return { items: [...page('first').items, ...page('older').items], nextCursor: null }
    })
    state.query.value = 'archive'
    await vi.advanceTimersByTimeAsync(220)
    await state.loadMore()
    expect(state.items.value.map(item => item.conversation.id)).toEqual(['first'])
    expect(state.nextCursor.value).toBe('cursor-a')
    expect(state.failed.value).toBe(true)
    expect(state.errors).toEqual(['failed'])
    failure = false
    await state.loadMore()
    expect(requests).toEqual([undefined, 'cursor-a', 'cursor-a'])
    expect(state.items.value.map(item => item.conversation.id)).toEqual(['first', 'older'])
    expect(state.nextCursor.value).toBeNull()
    expect(state.failed.value).toBe(false)
  })

  it('does not resurrect closed results or show stale errors after query changes and disposal', async () => {
    const request = deferred()
    const state = create(() => request.promise)
    state.query.value = 'old'
    await vi.advanceTimersByTimeAsync(220)
    state.show.value = false
    request.reject(new Error('late'))
    await Promise.resolve()
    expect(state.errors).toEqual([])
    expect(state.items.value).toEqual([])
    expect(state.loading.value).toBe(false)

    const late = deferred()
    const disposed = create(() => late.promise)
    disposed.query.value = 'old'
    await vi.advanceTimersByTimeAsync(220)
    disposed.scope.stop()
    late.resolve(page('late-result'))
    await Promise.resolve()
    expect(disposed.items.value).toEqual([])
  })

  it('distinguishes an initial failure from a completed empty search and supports retry', async () => {
    let failure = true
    const state = create(async () => {
      if (failure)
        throw new Error('unavailable')
      return { items: [], nextCursor: null }
    })
    state.query.value = 'missing'
    await vi.advanceTimersByTimeAsync(220)
    expect(state.failed.value).toBe(true)
    failure = false
    await state.loadMore()
    expect(state.failed.value).toBe(false)
    expect(state.items.value).toEqual([])
    expect(state.loading.value).toBe(false)
  })
})
