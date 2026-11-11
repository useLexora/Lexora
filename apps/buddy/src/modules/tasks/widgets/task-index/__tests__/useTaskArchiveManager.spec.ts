import type { ConversationArchiveItem, ConversationArchivePage } from '@buddy-shared/conversation/conversationArchiveApi'
import type { TaskArchiveActions } from '../../../contracts'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useTaskArchiveManager } from '../useTaskArchiveManager'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
})
function item(id: string): ConversationArchiveItem {
  return { id, title: id, spaceId: null, archivedAt: '2026-09-01T00:00:00Z', deletedAt: null, updatedAt: '2026-09-01T00:00:00Z', metadataRevision: 2, deletionStatus: null, errorCode: null }
}
function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const ready = shallowRef(true)
  const show = shallowRef(false)
  const list = vi.fn<TaskArchiveActions['list']>().mockResolvedValue({ items: [], nextCursor: null })
  const remove = vi.fn<TaskArchiveActions['delete']>().mockResolvedValue(true)
  const actions: TaskArchiveActions = { get: vi.fn(), onChanged: () => () => {}, ready, list, delete: remove, archive: vi.fn(), restore: vi.fn(), getPolicy: vi.fn(), setPolicy: vi.fn() }
  const state = scope.run(() => useTaskArchiveManager({ actions: () => actions, show: () => show.value, errorMessage: error => String(error), notDeletedMessage: () => 'Not deleted' }))!
  return { state, ready, show, list, remove, scope }
}

describe('archive manager', () => {
  it('isolates late search and readiness responses without treating them as empty results', async () => {
    const f = fixture()
    const first = deferred<ConversationArchivePage>()
    const second = deferred<ConversationArchivePage>()
    f.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    f.show.value = true
    f.state.query.value = 'new'
    second.resolve({ items: [item('new')], nextCursor: null })
    await nextTick()
    first.resolve({ items: [item('old')], nextCursor: null })
    await nextTick()
    expect(f.state.items.value.map(item => item.id)).toEqual(['new'])
    const disconnected = deferred<ConversationArchivePage>()
    f.list.mockReturnValueOnce(disconnected.promise)
    const pending = f.state.load()
    f.ready.value = false
    disconnected.resolve({ items: [item('stale')], nextCursor: null })
    await pending
    expect(f.state.items.value).toEqual([])
    expect(f.state.loading.value).toBe(false)
    f.list.mockResolvedValueOnce({ items: [item('reconnected')], nextCursor: null })
    f.ready.value = true
    await nextTick()
    expect(f.state.items.value.map(item => item.id)).toEqual(['reconnected'])
  })

  it('scopes pagination to the selected space and rejects a late previous-space response', async () => {
    const f = fixture()
    const stale = deferred<ConversationArchivePage>()
    f.list.mockReturnValueOnce(stale.promise)
    f.show.value = true
    f.list.mockResolvedValueOnce({ items: [{ ...item('a'), spaceId: 'space-a' }], nextCursor: 'next-a' })
    f.state.spaceId.value = 'space-a'
    await nextTick()
    stale.resolve({ items: [item('stale')], nextCursor: 'stale-cursor' })
    await nextTick()
    expect(f.state.items.value.map(item => item.id)).toEqual(['a'])
    expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: '', spaceId: 'space-a', limit: 50 })
    f.list.mockResolvedValueOnce({ items: [{ ...item('a2'), spaceId: 'space-a' }], nextCursor: null })
    await f.state.load(true)
    expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: '', spaceId: 'space-a', limit: 50, cursor: 'next-a' })
    expect(f.state.items.value.map(item => item.id)).toEqual(['a', 'a2'])
    f.state.spaceId.value = null
    await nextTick()
    expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: '', spaceId: null, limit: 50 })
    expect(f.state.items.value).toEqual([])
    f.state.spaceId.value = undefined
    await nextTick()
    expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: '', limit: 50 })
  })

  it('submits a fixed ID batch and records false, rejection and acceptance individually', async () => {
    const f = fixture()
    f.show.value = true
    await nextTick()
    const first = deferred<boolean>()
    f.remove.mockReturnValueOnce(first.promise).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('cleanup failed'))
    const targets = [item('one'), item('two'), item('three')]
    const pending = f.state.deleteBatch(targets)
    targets.splice(1)
    f.state.query.value = 'different'
    f.state.spaceId.value = 'different-space'
    first.resolve(true)
    await pending
    expect(f.remove.mock.calls.map(([id, revision]) => [id, revision])).toEqual([['one', 2], ['two', 2], ['three', 2]])
    expect(f.state.results.value.map(result => [result.item.id, result.status])).toEqual([['one', 'submitted'], ['two', 'failed'], ['three', 'failed']])
    expect(f.state.results.value[1]?.error).toContain('Not deleted')
    expect(f.state.results.value[2]?.error).toContain('cleanup failed')
    expect(f.state.busy.value).toBe(false)
  })

  it('updates pending cleanup automatically without a manual refresh', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.list.mockResolvedValueOnce({ items: [{ ...item('pending'), deletionStatus: 'pending' }, item('retained')], nextCursor: null })
    f.show.value = true
    await nextTick()
    expect(f.state.items.value).toHaveLength(2)
    f.list.mockResolvedValueOnce({ items: [item('retained')], nextCursor: null })
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.state.items.value.map(item => item.id)).toEqual(['retained'])
  })

  it('only includes archived tasks and their failed cleanup in whole-space confirmation', async () => {
    const f = fixture()
    f.show.value = true
    await nextTick()
    f.list.mockResolvedValueOnce({ items: [item('archived'), { ...item('failed'), deletionStatus: 'failed' }, { ...item('pending'), deletionStatus: 'pending' }, { ...item('active-failed'), archivedAt: null, deletionStatus: 'failed' }], nextCursor: null })
    expect((await f.state.snapshotSpace('space-a'))?.map(item => item.id)).toEqual(['archived', 'failed'])
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('does not offer a partial space snapshot when a later page fails', async () => {
    const f = fixture()
    f.show.value = true
    await nextTick()
    f.list.mockResolvedValueOnce({ items: [item('first')], nextCursor: 'second-page' }).mockRejectedValueOnce(new Error('snapshot failed'))
    expect(await f.state.snapshotSpace(null)).toBeNull()
    expect(f.state.error.value).toContain('snapshot failed')
    expect(f.state.busy.value).toBe(false)
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('drops a space preview when the runtime disconnects before all pages arrive', async () => {
    const f = fixture()
    f.show.value = true
    await nextTick()
    const page = deferred<ConversationArchivePage>()
    f.list.mockReturnValueOnce(page.promise)
    const snapshot = f.state.snapshotSpace('space-a')
    f.ready.value = false
    page.resolve({ items: [item('stale')], nextCursor: null })
    expect(await snapshot).toBeNull()
    expect(f.state.busy.value).toBe(false)
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('does not report acceptance, hidden or disconnected tasks as completed deletion', async () => {
    const f = fixture()
    const first = deferred<boolean>()
    f.remove.mockReturnValueOnce(first.promise)
    const pending = f.state.deleteBatch([item('one'), item('two')])
    f.ready.value = false
    first.resolve(true)
    await pending
    expect(f.remove.mock.calls.map(([id]) => id)).toEqual(['one'])
    expect(f.state.results.value.map(result => result.status)).toEqual(['submitted', 'failed'])
  })
})
