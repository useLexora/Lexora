import type { ConversationHistoryQuery, LocalConversationHistoryItem, LocalConversationHistoryPage } from '@buddy-shared/conversation/conversationHistoryApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { useTaskHistory } from '../useTaskHistory'

function item(index: number, spaceId: string | null = null): LocalConversationHistoryItem {
  const id = `task-${index}`
  const time = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
  return {
    conversation: { id, title: id, spaceId, createdAt: time, updatedAt: time, deletedAt: null, buddyId: 'default', activeBranchId: `${id}-branch`, approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, activity: 'idle', automationOccurrence: null },
    markState: { conversationId: id, markId: null, resultRunId: null, unread: false, readRevision: 0 },
  }
}

function fixture() {
  let items = [...Array.from({ length: 40 }, (_, index) => item(index)), ...Array.from({ length: 20 }, (_, index) => item(100 + index, 'space'))]
  const queries: ConversationHistoryQuery[] = []
  let intercept: ((query: ConversationHistoryQuery) => Promise<LocalConversationHistoryPage> | undefined) | undefined
  let interceptLookup: ((ids: readonly string[]) => Promise<readonly LocalConversationHistoryItem[]> | undefined) | undefined
  function page(query: ConversationHistoryQuery): LocalConversationHistoryPage {
    const attention = (entry: LocalConversationHistoryItem) => entry.markState.markId !== null || entry.markState.unread || entry.conversation.activity !== 'idle'
    const filtered = items.filter(entry => query.kind === 'attention'
      ? attention(entry)
      : query.kind === 'search'
        ? entry.conversation.title?.includes(query.query ?? '')
        : entry.conversation.spaceId === query.spaceId && !attention(entry) && !query.excludeIds?.includes(entry.conversation.id))
      .sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
    const offset = query.cursor ? Number(query.cursor) : 0
    const end = offset + (query.limit ?? 10)
    return { items: filtered.slice(offset, end).map(entry => structuredClone(entry)), nextCursor: end < filtered.length ? String(end) : null }
  }
  const history = useTaskHistory({
    listHistory: async (query) => {
      queries.push(query)
      return await intercept?.(query) ?? page(query)
    },
    getHistoryEntries: async (ids) => {
      return await interceptLookup?.(ids) ?? items.filter(entry => ids.includes(entry.conversation.id)).map(entry => structuredClone(entry))
    },
  })
  return {
    ...history,
    queries,
    page,
    intercept(value: typeof intercept) { intercept = value },
    interceptLookup(value: typeof interceptLookup) { interceptLookup = value },
    replace(value: LocalConversationHistoryItem) { items = items.map(entry => entry.conversation.id === value.conversation.id ? value : entry) },
    remove(id: string) { items = items.filter(entry => entry.conversation.id !== id) },
  }
}

const ids = (f: ReturnType<typeof fixture>) => f.conversations.value.map(task => task.id)

describe('progressive task history', () => {
  it('counts attention within each scope quota while retaining independent old pins', async () => {
    const f = fixture()
    const marked = { ...item(0), markState: { ...item(0).markState, markId: 'keep' } }
    f.replace(marked)
    await f.setPinnedIds(['task-1'])
    await f.refreshConversations()
    expect(ids(f)).toHaveLength(11)
    expect(ids(f)).toEqual(expect.arrayContaining(['task-0', 'task-1', 'task-39']))
    await f.history.ensureScope('space')
    expect(ids(f).filter(id => Number(id.split('-')[1]) >= 100)).toHaveLength(5)
    await f.history.loadMore('space')
    expect(ids(f).filter(id => Number(id.split('-')[1]) >= 100)).toHaveLength(15)
    expect(ids(f).filter(id => Number(id.split('-')[1]) < 100)).toHaveLength(11)
    await f.refreshConversations()
    expect(ids(f)).toHaveLength(26)
    expect(f.history.scopes.value.get('space:space')).toEqual({ initialized: true, loading: false, hasMore: true })
    await f.setPinnedIds(['task-0'])
    expect(ids(f)).toHaveLength(26)
    expect(ids(f)).toContain('task-30')
  })

  it.each([5, 7])('counts %i marked tasks toward the initial five and adds ten on expansion', async (count) => {
    const f = fixture()
    const marked = Array.from({ length: count }, (_, index) => ({ ...item(100 + index, 'space'), markState: { ...item(100 + index).markState, markId: 'keep' } }))
    marked.forEach(entry => f.replace(entry))
    await f.refreshAttention()
    await f.history.ensureScope('space')
    expect(ids(f)).toHaveLength(Math.max(5, count))
    expect(ids(f)).toEqual(expect.arrayContaining(marked.map(entry => entry.conversation.id)))
    await f.history.loadMore('space')
    expect(ids(f)).toHaveLength(Math.max(5, count) + 10)
    expect(new Set(ids(f)).size).toBe(ids(f).length)
  })

  it.each([0, 1])('keeps the continuation accurate with seven marks and %i ordinary tasks', async (remaining) => {
    const f = fixture()
    for (let index = 100; index < 107; index++)
      f.replace({ ...item(index, 'space'), markState: { ...item(index).markState, markId: 'keep' } })
    for (let index = 107; index < 120 - remaining; index++)
      f.remove(`task-${index}`)
    await f.refreshAttention()
    await f.history.ensureScope('space')
    expect(ids(f)).toHaveLength(7)
    expect(ids(f)).not.toContain('task-119')
    expect(f.history.scopes.value.get('space:space')?.hasMore).toBe(remaining === 1)
    await f.history.loadMore('space')
    expect(ids(f)).toHaveLength(7 + remaining)
    expect(f.history.scopes.value.get('space:space')?.hasMore).toBe(false)
  })

  it('rebalances ordinary slots as marks cross the quota without resetting an expanded window', async () => {
    const f = fixture()
    await f.history.ensureScope('space')
    expect(ids(f)).not.toContain('task-100')
    for (let index = 100; index < 107; index++) {
      const entry = { ...item(index, 'space'), markState: { ...item(index).markState, markId: 'keep' } }
      f.replace(entry)
      await f.applyMarkState(entry.markState)
      expect(ids(f)).toContain(entry.conversation.id)
      expect(f.markStates.value.get(entry.conversation.id)?.markId).toBe('keep')
      expect(ids(f)).toHaveLength(Math.max(5, index - 99))
    }
    for (let index = 103; index < 107; index++) {
      f.replace(item(index, 'space'))
      await f.applyMarkState(item(index).markState)
    }
    expect(ids(f)).toHaveLength(5)
    expect(ids(f)).toEqual(expect.arrayContaining(['task-118', 'task-119']))
    await f.history.loadMore('space')
    expect(ids(f)).toHaveLength(15)
    f.replace(item(100, 'space'))
    await f.applyMarkState(item(100).markState)
    expect(ids(f)).toHaveLength(15)
  })

  it('rebalances both scopes when a marked task moves during an attention refresh', async () => {
    const f = fixture()
    const marked = { ...item(100, 'space'), markState: { ...item(100).markState, markId: 'keep' } }
    f.replace(marked)
    await f.refreshConversations()
    await f.history.ensureScope('space')
    f.replace({ ...marked, conversation: { ...marked.conversation, spaceId: null, activity: 'awaiting_approval' } })
    await f.refreshAttention()
    expect(f.conversations.value.filter(task => task.spaceId === 'space')).toHaveLength(5)
    expect(f.conversations.value.filter(task => task.spaceId === null)).toHaveLength(10)
    expect(new Set(ids(f)).size).toBe(15)
    expect(f.conversations.value.find(task => task.id === 'task-100')?.activity).toBe('awaiting_approval')
  })

  it('applies model controls without invalidating loaded history or changing its order', async () => {
    const f = fixture()
    await f.history.ensureScope('space')
    const before = f.conversations.value
    const scopes = f.history.scopes.value
    const queries = f.queries.length
    const selection = { providerId: 'fixture', modelId: 'model-2', reasoning: 'high' as const, serviceTier: 'priority' as const }
    const updated = { ...item(117, 'space'), conversation: { ...item(117, 'space').conversation, modelSelection: selection } }
    f.replace(updated)
    await f.applyConversation(updated.conversation)
    expect(ids(f)).toEqual(before.map(task => task.id))
    expect(f.conversations.value.find(task => task.id === 'task-117')).toMatchObject({ modelSelection: selection, updatedAt: updated.conversation.updatedAt })
    expect(f.conversations.value[0]).toBe(before[0])
    expect(f.history.scopes.value).toBe(scopes)
    expect(f.queries).toHaveLength(queries)
    await f.history.loadMore('space')
    expect(f.conversations.value).toHaveLength(15)
    expect(f.conversations.value.find(task => task.id === 'task-117')?.modelSelection).toEqual(selection)
  })

  it('coalesces pagination and appends the next page without losing or duplicating loaded tasks', async () => {
    const f = fixture()
    await f.history.ensureScope(null)
    const pending = deferred<LocalConversationHistoryPage>()
    f.intercept(query => query.kind === 'ordinary' && query.cursor ? pending.promise : undefined)
    const count = f.queries.length
    const first = f.history.loadMore(null)
    const second = f.history.loadMore(null)
    await Promise.resolve()
    const query = f.queries.at(-1)!
    expect(query).toMatchObject({ cursor: '10', limit: 10 })
    pending.resolve(f.page(query))
    await Promise.all([first, second])
    expect(f.queries).toHaveLength(count + 1)
    expect(ids(f)).toEqual(Array.from({ length: 20 }, (_, index) => `task-${39 - index}`))
  })

  it('preserves loaded rows on failure and retries the same page', async () => {
    const f = fixture()
    await f.history.ensureScope(null)
    const before = f.conversations.value
    f.intercept(query => query.cursor ? Promise.reject(new Error('offline')) : undefined)
    await expect(f.history.loadMore(null)).rejects.toThrow('offline')
    expect(f.conversations.value).toEqual(before)
    expect(f.history.scopes.value.get('global')).toEqual({ initialized: true, loading: false, hasMore: true })
    f.intercept(undefined)
    await f.history.loadMore(null)
    expect(ids(f)).toHaveLength(20)
  })

  it('discards an old page after marking a task and refills ordinary capacity without duplicates', async () => {
    const f = fixture()
    await f.history.ensureScope(null)
    const pending = deferred<LocalConversationHistoryPage>()
    let intercepted = false
    let stale: LocalConversationHistoryPage | undefined
    f.intercept((query) => {
      if (query.cursor && !intercepted) {
        intercepted = true
        stale = f.page(query)
        return pending.promise
      }
    })
    const loading = f.history.loadMore(null)
    await Promise.resolve()
    const marked = { ...item(39), markState: { ...item(39).markState, markId: 'keep' } }
    f.replace(marked)
    const assigning = f.applyMarkState(marked.markState)
    pending.resolve(stale!)
    await Promise.all([loading, assigning])
    expect(ids(f)).toHaveLength(20)
    expect(new Set(ids(f)).size).toBe(20)
    expect(f.markStates.value.get('task-39')?.markId).toBe('keep')
  })

  it('keeps only the active old task in addition to ordinary history and searches the complete index', async () => {
    const f = fixture()
    await f.refreshConversations()
    await f.history.setActiveTask('task-0')
    expect(ids(f)).toContain('task-0')
    await f.history.setActiveTask('task-1')
    expect(ids(f)).not.toContain('task-0')
    expect(ids(f)).toHaveLength(11)
    const result = await f.history.search('task-0')
    expect(result.items.map(entry => entry.conversation.id)).toEqual(['task-0'])
    expect(ids(f)).not.toContain('task-0')
  })

  it('does not restore a deleted task from a pending page', async () => {
    const f = fixture()
    await f.history.ensureScope(null)
    const pending = deferred<LocalConversationHistoryPage>()
    let stale: LocalConversationHistoryPage | undefined
    let intercepted = false
    f.intercept((query) => {
      if (query.cursor && !intercepted) {
        intercepted = true
        stale = f.page(query)
        return pending.promise
      }
    })
    const loading = f.history.loadMore(null)
    await Promise.resolve()
    f.remove('task-25')
    const deleting = f.applyConversation({ ...item(25).conversation, deletedAt: '2026-09-02T00:00:00.000Z' })
    pending.resolve(stale!)
    await Promise.all([loading, deleting])
    expect(ids(f)).not.toContain('task-25')
    expect(ids(f)).toHaveLength(20)
  })

  it('refills both the original and destination scope after moving a visible task', async () => {
    const f = fixture()
    await f.refreshConversations()
    await f.history.ensureScope('space')
    const moved = { ...item(39), conversation: { ...item(39).conversation, spaceId: 'space', updatedAt: '2026-09-03T00:00:00.000Z' } }
    f.replace(moved)
    await f.applyConversation(moved.conversation)
    expect(f.conversations.value.filter(task => task.spaceId === null)).toHaveLength(10)
    expect(f.conversations.value.filter(task => task.spaceId === 'space')).toHaveLength(5)
    expect(ids(f)).toContain('task-29')
    expect(f.conversations.value.find(task => task.id === 'task-39')?.spaceId).toBe('space')
  })

  it('does not overwrite a new unread result with an earlier in-flight pinned lookup', async () => {
    const f = fixture()
    await f.history.ensureScope(null)
    const pending = deferred<readonly LocalConversationHistoryItem[]>()
    let intercepted = false
    f.interceptLookup((ids) => {
      if (ids.includes('task-0') && !intercepted) {
        intercepted = true
        return pending.promise
      }
    })
    const pinning = f.setPinnedIds(['task-0'])
    await Promise.resolve()
    const next = { ...item(0), markState: { ...item(0).markState, resultRunId: 'new-result', unread: true } }
    f.replace(next)
    await f.refreshAttention()
    expect(f.markStates.value.get('task-0')?.unread).toBe(true)
    pending.resolve([item(0)])
    await pinning
    expect(f.markStates.value.get('task-0')).toEqual(next.markState)
  })

  it('does not publish requests after disposal', async () => {
    const f = fixture()
    const pending = deferred<LocalConversationHistoryPage>()
    f.intercept(() => pending.promise)
    const loading = f.history.ensureScope(null)
    await Promise.resolve()
    f.dispose()
    pending.resolve(f.page({ kind: 'ordinary', spaceId: null, limit: 10 }))
    await loading
    expect(ids(f)).toEqual([])
  })
})
