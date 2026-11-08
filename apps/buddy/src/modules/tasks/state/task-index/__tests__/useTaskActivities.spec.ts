import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { ExecutionsChanged, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useTaskActivities } from '../useTaskActivities'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
})
function task(activity: LocalConversationSummary['activity'] = 'running', branch = 'branch'): LocalConversationSummary {
  return { id: 'task', activity, activeBranchId: branch } as LocalConversationSummary
}
function execution(waitingFor: LocalExecution['waitingFor'], phase: LocalExecution['phase'] = 'waiting', stopping = false): LocalExecution {
  return { runId: 'child', kind: 'npc_child', waitingFor, phase, stopping } as LocalExecution
}
function fixture() {
  vi.useFakeTimers()
  const scope = effectScope()
  scopes.push(scope)
  const tasks = shallowRef<readonly LocalConversationSummary[]>([task()])
  const listeners = new Set<(event: ExecutionsChanged) => void>()
  const list = vi.fn<LexoraDesktopApi['localChat']['executions']['list']>().mockResolvedValue([])
  const errors: unknown[] = []
  const api = { list, onChanged: (listener: (event: ExecutionsChanged) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }
  const state = scope.run(() => useTaskActivities({ api, tasks, onError: error => errors.push(error) }))!
  const change = () => listeners.forEach(listener => listener({ conversationId: 'task' } as ExecutionsChanged))
  async function publish(executions: LocalExecution[]) {
    list.mockResolvedValue(executions)
    change()
    await vi.advanceTimersByTimeAsync(101)
  }
  return { tasks, list, state, scope, change, publish, errors }
}

describe('task sidebar execution activity', () => {
  it('uses a blocking user wait, including children, rather than merely a pending question or other waits', async () => {
    const f = fixture()
    await f.publish([execution(null, 'working')])
    expect(f.state.activities.value.get('task')).toBe('running')
    for (const waitingFor of ['children', 'resource', 'answer'] as const) {
      await f.publish([execution(waitingFor)])
      expect(f.state.activities.value.get('task')).toBe('running')
    }
    await f.publish([execution('user_answer')])
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
    await f.publish([execution('user_answer', 'working')])
    expect(f.state.activities.value.get('task')).toBe('running')
    await f.publish([execution('user_answer', 'waiting', true)])
    expect(f.state.activities.value.get('task')).toBe('running')
    await f.publish([execution('user_answer', 'closed')])
    expect(f.state.activities.value.get('task')).toBe('running')
  })

  it('restores running after answering and prioritizes approval over waiting', async () => {
    const f = fixture()
    await f.publish([execution('user_answer')])
    f.tasks.value = [task('awaiting_approval')]
    await nextTick()
    expect(f.state.activities.value.get('task')).toBe('awaiting_approval')
    f.tasks.value = [task()]
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
    await f.publish([execution(null, 'working')])
    expect(f.state.activities.value.get('task')).toBe('running')
    f.tasks.value = [task('idle')]
    await nextTick()
    expect(f.state.activities.value.get('task')).toBe('idle')
  })

  it('discards stale responses after newer events, branch changes and disposal', async () => {
    const f = fixture()
    const stale = deferred<LocalExecution[]>()
    f.list.mockReturnValueOnce(stale.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    await f.publish([execution(null, 'working')])
    stale.resolve([execution('user_answer')])
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')

    const oldBranch = deferred<LocalExecution[]>()
    f.list.mockReturnValueOnce(oldBranch.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    f.tasks.value = [task('running', 'new-branch')]
    await nextTick()
    oldBranch.resolve([execution('user_answer')])
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')

    const disposed = deferred<LocalExecution[]>()
    f.list.mockReturnValueOnce(disposed.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    f.scope.stop()
    disposed.resolve([execution('user_answer')])
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')
  })

  it('drops stale waiting state on a failed refresh and recovers on the next event', async () => {
    const f = fixture()
    await f.publish([execution('user_answer')])
    f.list.mockRejectedValueOnce(new Error('temporarily unavailable'))
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    expect(f.state.activities.value.get('task')).toBe('running')
    expect(f.errors).toHaveLength(1)
    await f.publish([execution('user_answer')])
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
  })
})
