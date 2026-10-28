import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalExecutionInputReceipt, LocalExecutionInputsPage } from '@buddy-shared/executions/executionInputReceipt'
import type { ExecutionsChanged, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useChatExecutionTree } from '../useChatExecutionTree'

const now = '2026-10-12T00:00:00.000Z'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function execution(runId: string, kind: LocalExecution['kind'] = 'root'): LocalExecution {
  return { runId, rootRunId: runId, parentRunId: null, buddyId: 'default', buddyName: 'Lexora', ordinal: null, kind, phase: 'working', status: 'running', startedAt: now, completedAt: null, updatedAt: now, progress: null, toolCount: 0, usage: null, stopping: false, task: 'Task', waitingFor: null, activeChildren: 0, canCancel: true, canAnswer: false, canSend: false, cleanup: 'pending', errorCode: null, affectedResources: [], questions: [] }
}
function receipt(runId: string, branchId = 'branch'): LocalExecutionInputReceipt {
  return { conversationId: 'task', branchId, runId, rootRunId: runId, buddyId: 'default', buddyName: 'Lexora', task: 'Task', messageId: `input-${runId}`, kind: 'supplement', text: `Private ${runId}`, createdAt: now, state: 'pending' }
}
function setup(overrides: Partial<LocalChatApi['executions']> = {}) {
  let changed: ((notice: ExecutionsChanged) => void) | undefined
  const api: LocalChatApi['executions'] = {
    list: async () => [execution('root')],
    inputs: async input => ({ inputs: [receipt(input.runIds[0]!, input.branchId)], nextOffset: null }),
    detail: async () => { throw new Error('Not used') },
    events: async () => ({ events: [], nextSequence: 0, hasMore: false }),
    answer: async () => ({ accepted: true }),
    send: async () => ({ accepted: true }),
    sendDraft: async () => null,
    cancel: async () => ({ cancelled: true }),
    cancelChildren: async () => ({ cancelledRunIds: [] }),
    onChanged: (listener) => {
      changed = listener
      return () => {}
    },
    ...overrides,
  }
  const conversationId = shallowRef<string | null>('task')
  const branchId = shallowRef<string | null>('branch')
  const ready = shallowRef(true)
  const onError = vi.fn()
  const scope = effectScope()
  const state = scope.run(() => useChatExecutionTree({ api, conversationId, branchId, ready, onError }))!
  cleanups.push(() => scope.stop())
  return { api, state, conversationId, branchId, ready, onError, changed: () => changed?.({ sourceId: 'source', revision: 1, conversationId: conversationId.value!, rootRunId: 'root' }) }
}

describe('execution input receipt scope', () => {
  it.each(['branch', 'conversation'] as const)('ignores a late receipt page after changing %s', async (target) => {
    const late = deferred<LocalExecutionInputsPage>()
    const pending = vi.fn(async (input: Parameters<LocalChatApi['executions']['inputs']>[0]) => input.conversationId === 'task' && input.branchId === 'branch'
      ? late.promise
      : { inputs: [{ ...receipt('root', input.branchId), conversationId: input.conversationId, text: 'New scope' }], nextOffset: null })
    const f = setup({ inputs: pending })
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce())
    if (target === 'branch')
      f.branchId.value = 'other-branch'
    else
      f.conversationId.value = 'other-task'
    await nextTick()
    late.resolve({ inputs: [receipt('root')], nextOffset: null })
    await vi.waitFor(() => expect(f.state.inputs.value[0]?.text).toBe('New scope'))
    expect(f.state.inputs.value[0]).toMatchObject({ conversationId: f.conversationId.value, branchId: f.branchId.value })
    expect(f.onError).not.toHaveBeenCalled()
  })

  it('retains all previous receipts after a partial page failure and a temporary disconnect', async () => {
    const f = setup()
    await vi.waitFor(() => expect(f.state.inputs.value).toHaveLength(1))
    const previous = f.state.inputs.value
    f.api.inputs = async input => input.offset === 0
      ? { inputs: [{ ...receipt('root'), text: 'Partial refresh' }], nextOffset: 100 }
      : Promise.reject(new Error('Disconnected'))
    await f.state.refresh()
    expect(f.state.inputs.value).toEqual(previous)
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disconnected' }))
    f.ready.value = false
    await nextTick()
    expect(f.state.inputs.value).toEqual(previous)
    f.api.inputs = async () => ({ inputs: [{ ...receipt('root'), state: 'consumed' }], nextOffset: null })
    f.ready.value = true
    await vi.waitFor(() => expect(f.state.inputs.value[0]?.state).toBe('consumed'))
  })

  it('reads every bounded run batch and continues past filtered empty pages', async () => {
    const records = [...Array.from({ length: 51 }, (_, index) => execution(`root-${index}`)), execution('npc', 'npc_child')]
    const f = setup({
      list: async () => records,
      inputs: async input => input.offset === 0
        ? { inputs: [], nextOffset: 100 }
        : { inputs: input.runIds.map(runId => receipt(runId)), nextOffset: null },
    })
    await vi.waitFor(() => expect(f.state.inputs.value).toHaveLength(51))
    expect(f.state.inputs.value.map(input => input.runId)).toEqual(records.slice(0, 51).map(record => record.runId))
  })

  it('refreshes delivery state from execution notices and rejects wrong-scope pages', async () => {
    const f = setup()
    await vi.waitFor(() => expect(f.state.inputs.value[0]?.state).toBe('pending'))
    f.api.inputs = async () => ({ inputs: [{ ...receipt('root'), state: 'accepted' }], nextOffset: null })
    f.changed()
    await vi.waitFor(() => expect(f.state.inputs.value[0]?.state).toBe('accepted'))
    f.api.inputs = async () => ({ inputs: [receipt('root', 'unrelated-branch')], nextOffset: null })
    await f.state.refresh()
    expect(f.state.inputs.value[0]?.state).toBe('accepted')
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid execution input page' }))
  })
})
