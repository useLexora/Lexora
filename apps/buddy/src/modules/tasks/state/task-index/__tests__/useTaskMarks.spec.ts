import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalTaskMark, LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useTaskMarks } from '../useTaskMarks'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const custom: LocalTaskMark = { id: 'mark', name: '需要验证', description: '', color: '#3979d6', taskCount: 0, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' }
function fixture(withSource = false) {
  let state: LocalTaskMarkState = { conversationId: 'a', markId: null, resultRunId: 'result', unread: true, readRevision: 0 }
  const api: LocalChatApi['taskMarks'] = {
    list: vi.fn(async () => [{ ...custom, taskCount: Number(state.markId === custom.id) }]),
    states: vi.fn(async () => [state]),
    create: async input => ({ ...custom, ...input }),
    update: async input => ({ ...custom, ...input }),
    delete: async () => true,
    assign: async (_id, markId) => state = { ...state, markId },
    clear: async (input) => {
      const read = input.resultRunId === state.resultRunId && input.readRevision === state.readRevision
      return state = { ...state, markId: null, unread: read ? false : state.unread, readRevision: state.readRevision + Number(read) }
    },
    setRead: vi.fn(async (input) => {
      if (input.read && (input.resultRunId !== state.resultRunId || input.readRevision !== state.readRevision))
        return state
      return state = { ...state, unread: !input.read, readRevision: state.readRevision + 1 }
    }),
  }
  const scope = effectScope()
  const stateSource = withSource ? shallowRef<ReadonlyMap<string, LocalTaskMarkState>>(new Map([['a', state]])) : undefined
  const store = scope.run(() => useTaskMarks({ api, stateSource, conversations: shallowRef([]), activeConversationId: shallowRef('a'), ready: shallowRef(true), language: shallowRef('zh-CN') }))!
  cleanups.push(() => scope.stop())
  return { api, store, stateSource, getState: () => state, replace: (value: Partial<LocalTaskMarkState>) => state = { ...state, ...value } }
}

describe('task mark owner', () => {
  it('keeps manual unread during a visit, reads it on a later visit, and clears both states without deleting the mark', async () => {
    const f = fixture()
    await f.store.refresh()
    await f.store.assign('a', 'mark')
    await f.store.setRead('a', false)
    const state = f.store.states.value.get('a')!
    await f.store.readResult('a', state.resultRunId!, state.readRevision)
    expect(f.store.states.value.get('a')).toMatchObject({ unread: true, markId: 'mark' })
    f.store.beginVisit('a')
    await f.store.readResult('a', state.resultRunId!, state.readRevision)
    expect(f.store.states.value.get('a')).toMatchObject({ unread: false, markId: 'mark' })
    await f.store.setRead('a', false)
    const before = f.store.states.value.get('a')!
    expect(await f.store.clear('a')).toBe(true)
    expect(f.store.states.value.get('a')).toEqual({ ...before, markId: null, unread: false, readRevision: before.readRevision + 1 })
    expect(f.store.items.value).toEqual([custom])
  })

  it('retains later manual unread queued behind a clear during the same visit', async () => {
    const f = fixture()
    await f.store.refresh()
    await f.store.assign('a', 'mark')
    const clearing = f.store.clear('a')
    const marking = f.store.setRead('a', false)
    await Promise.all([clearing, marking])
    const manual = f.store.states.value.get('a')!
    await f.store.readResult('a', manual.resultRunId!, manual.readRevision)
    expect(f.store.states.value.get('a')).toMatchObject({ markId: null, unread: true })
    f.store.beginVisit('a')
    await f.store.readResult('a', manual.resultRunId!, manual.readRevision)
    expect(f.store.states.value.get('a')?.unread).toBe(false)
  })

  it('uses the clear request snapshot without marking a later result as read', async () => {
    const f = fixture()
    await f.store.refresh()
    await f.store.assign('a', 'mark')
    const clearing = f.store.clear('a')
    f.replace({ resultRunId: 'new-result' })
    expect(await clearing).toBe(true)
    expect(f.store.states.value.get('a')).toMatchObject({ markId: null, unread: true, resultRunId: 'new-result' })
    expect(f.store.items.value).toEqual([custom])
  })

  it('keeps both states and reports a failed clear without changing the assignment count', async () => {
    const f = fixture()
    await f.store.refresh()
    await f.store.assign('a', 'mark')
    const before = f.store.states.value.get('a')!
    f.api.clear = async () => {
      throw new Error('clear failed')
    }
    expect(await f.store.clear('a')).toBe(false)
    expect(f.store.states.value.get('a')).toEqual(before)
    expect(f.store.items.value[0]?.taskCount).toBe(1)
    expect(f.store.busy.value).toBe(false)
    expect(f.store.error.value).toBeTruthy()
  })

  it('does not clear new results using the visible identity of a previous result', async () => {
    const f = fixture()
    await f.store.refresh()
    const previous = f.store.states.value.get('a')!
    f.replace({ resultRunId: 'new-result' })
    await f.store.refresh()
    await f.store.readResult('a', previous.resultRunId!, previous.readRevision)
    expect(f.store.states.value.get('a')).toMatchObject({ resultRunId: 'new-result', unread: true })
    await f.store.readResult('a', 'new-result', previous.readRevision)
    expect(f.store.states.value.get('a')?.unread).toBe(false)
  })

  it('rejects stale refresh snapshots while applying a mark and then recovers the current snapshot', async () => {
    const f = fixture()
    await f.store.refresh()
    const delayed = deferred<readonly LocalTaskMarkState[]>()
    const previous = f.getState()
    vi.mocked(f.api.states).mockReturnValueOnce(delayed.promise)
    const refresh = f.store.refresh()
    await f.store.assign('a', 'mark')
    delayed.resolve([previous])
    await refresh
    await vi.waitFor(() => expect(f.store.states.value.get('a')?.markId).toBe('mark'))
    await f.store.remove('mark')
    expect(f.store.items.value).toEqual([])
    expect(f.store.states.value.get('a')).toMatchObject({ markId: null, unread: true })
  })

  it('preserves a newer unread result when an earlier read receipt arrives after the page source updated', async () => {
    const f = fixture(true)
    await f.store.refresh()
    const delayed = deferred<LocalTaskMarkState>()
    const oldReceipt = { ...f.getState(), unread: false, readRevision: 1 }
    vi.mocked(f.api.setRead).mockReturnValueOnce(delayed.promise)
    const reading = f.store.readResult('a', 'result', 0)
    await Promise.resolve()
    f.replace({ resultRunId: 'new-result', unread: true, readRevision: 1 })
    f.stateSource!.value = new Map([['a', f.getState()]])
    delayed.resolve(oldReceipt)
    await reading
    expect(f.store.states.value.get('a')).toEqual(f.getState())
    expect(f.store.states.value.get('a')).toMatchObject({ resultRunId: 'new-result', unread: true })
  })

  it('does not apply late work after the owner has been disposed', async () => {
    const f = fixture()
    await f.store.refresh()
    const delayed = deferred<LocalTaskMarkState>()
    f.api.assign = () => delayed.promise
    const assignment = f.store.assign('a', 'mark')
    await Promise.resolve()
    f.store.dispose()
    delayed.resolve({ ...f.getState(), markId: 'mark' })
    expect(await assignment).toBe(false)
    expect(f.store.states.value.get('a')?.markId).toBeNull()
  })
})
