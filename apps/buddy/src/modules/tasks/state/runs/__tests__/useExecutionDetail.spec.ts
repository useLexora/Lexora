import type { ExecutionTarget, LocalExecutionDetail } from '@buddy-shared/executions/executionPresentationApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useExecutionEnvironment } from '../chatExecutionContext'
import { useExecutionDetail } from '../useExecutionDetail'

vi.mock('../chatExecutionContext', () => ({ useExecutionEnvironment: vi.fn() }))
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))
const now = '2026-10-12T00:00:00.000Z'
const target = (runId: string): ExecutionTarget => ({ conversationId: 'task', branchId: 'branch', rootRunId: 'root', runId })
function detail(runId: string): LocalExecutionDetail {
  return {
    execution: { runId, rootRunId: 'root', parentRunId: 'root', buddyId: 'researcher', buddyName: 'Researcher', ordinal: 1, toolCount: 0, kind: 'npc_child', phase: 'working', status: 'running', startedAt: now, completedAt: null, updatedAt: now, progress: null, stopping: false, task: 'Private task', waitingFor: null, activeChildren: 0, canCancel: true, canAnswer: false, canSend: true, cleanup: 'pending', errorCode: null, affectedResources: [], questions: [] },
    run: { buddyId: 'researcher', approvalPolicy: 'policy', branchId: 'branch', completedAt: null, conversationId: 'task', errorCode: null, executionProfile: 'read_only', id: runId, modelId: 'model', providerId: 'provider', purpose: 'chat', reasoningLevel: null, startedAt: now, status: 'running', triggeringMessageId: 'goal' },
    caller: { runId: 'root', buddyName: 'Caller', ordinal: null },
    inputs: [],
    artifacts: [],
    changes: null,
    result: null,
    usage: null,
  }
}
function message(runId: string, sequence: number, text: string): LocalRunEvent {
  return { runId, sequence, createdAt: now, type: 'message.completed', payload: { messageId: `${runId}-${sequence}`, role: 'assistant', stopReason: 'completed', content: { text } } }
}
function setup() {
  const api: NonNullable<ReturnType<typeof useExecutionEnvironment>>['api'] = {
    list: vi.fn(async () => []),
    detail: vi.fn(async input => detail(input.runId)),
    events: vi.fn(async input => ({ events: [message(input.runId, 1, `${input.runId} private output`)], nextSequence: 1, hasMore: false })),
    answer: vi.fn(async () => ({ accepted: true })),
    sendDraft: async () => { throw new Error('No draft') },
    send: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    cancelChildren: vi.fn(async () => ({ cancelledRunIds: [] })),
    onChanged: vi.fn(() => () => {}),
  }
  const ready = shallowRef(true)
  vi.mocked(useExecutionEnvironment).mockReturnValue({ api, ready, selectedTarget: shallowRef(null), open: async () => {}, onError: vi.fn() })
  const scope = effectScope()
  cleanups.push(() => scope.stop())
  const selected = shallowRef(target('first'))
  const visible = shallowRef(true)
  const state = scope.run(() => useExecutionDetail(selected, visible))!
  return { api, selected, visible, ready, state }
}

describe('execution detail lifecycle', () => {
  it('discards a late private page after switching the selected execution', async () => {
    const f = setup()
    const late = deferred<{ events: LocalRunEvent[], nextSequence: number, hasMore: boolean }>()
    vi.mocked(f.api.events).mockImplementation(async input => input.runId === 'first' ? late.promise : { events: [message('second', 1, 'Second private output')], nextSequence: 1, hasMore: false })
    await vi.waitFor(() => expect(f.state.detail.value?.execution.runId).toBe('first'))
    f.selected.value = target('second')
    await nextTick()
    late.resolve({ events: [message('first', 1, 'Late first output')], nextSequence: 1, hasMore: false })
    await vi.waitFor(() => expect(JSON.stringify(f.state.rows.value)).toContain('Second private output'))
    expect(f.state.detail.value?.execution.runId).toBe('second')
    expect(JSON.stringify(f.state.rows.value)).not.toContain('Late first output')
  })

  it('retains paged history and its cursor across same-identity refreshes and hiding', async () => {
    const f = setup()
    let finish = false
    vi.mocked(f.api.events).mockImplementation(async input => (input.afterSequence ?? 0) === 0
      ? { events: [message(input.runId, 1, 'First page')], nextSequence: 1, hasMore: true }
      : input.afterSequence === 1
        ? { events: [message(input.runId, 2, 'Second page')], nextSequence: 2, hasMore: false }
        : finish ? { events: [message(input.runId, 3, 'Resumed output')], nextSequence: 3, hasMore: false } : { events: [], nextSequence: input.afterSequence ?? 0, hasMore: false })
    await vi.waitFor(() => expect(JSON.stringify(f.state.rows.value)).toContain('Second page'))
    f.selected.value = { ...f.selected.value }
    await nextTick()
    await f.state.refresh()
    expect(vi.mocked(f.api.events).mock.calls.at(-1)?.[0].afterSequence).toBe(2)
    f.visible.value = false
    await nextTick()
    finish = true
    f.visible.value = true
    await nextTick()
    await vi.waitFor(() => expect(JSON.stringify(f.state.rows.value)).toContain('Resumed output'))
    const rows = f.state.rows.value.filter(row => row.kind === 'message')
    expect(rows.map(row => row.message.content)).toEqual([{ text: 'First page' }, { text: 'Second page' }, { text: 'Resumed output' }])
    expect(f.state.detail.value?.execution.runId).toBe('first')
  })
})
