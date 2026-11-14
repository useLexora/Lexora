import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { ExecutionsChanged, LocalExecutionActivity } from '@buddy-shared/executions/executionPresentationApi'
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
function fixture() {
  vi.useFakeTimers()
  const scope = effectScope()
  scopes.push(scope)
  const tasks = shallowRef<readonly LocalConversationSummary[]>([task()])
  const listeners = new Set<(event: ExecutionsChanged) => void>()
  const activity = vi.fn<LexoraDesktopApi['localChat']['executions']['activity']>().mockResolvedValue({ hasBlockingAnswer: false })
  const errors: unknown[] = []
  const api = { activity, onChanged: (listener: (event: ExecutionsChanged) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }
  const state = scope.run(() => useTaskActivities({ api, tasks, onError: error => errors.push(error) }))!
  const change = () => listeners.forEach(listener => listener({ conversationId: 'task' } as ExecutionsChanged))
  async function publish(hasBlockingAnswer: boolean) {
    activity.mockResolvedValue({ hasBlockingAnswer })
    change()
    await vi.advanceTimersByTimeAsync(101)
  }
  return { tasks, activity, state, scope, change, publish, errors }
}

describe('task sidebar execution activity', () => {
  it('keeps task-wide waiting across branch changes, prioritizes approval and clears waiting after answering or becoming idle', async () => {
    const f = fixture()
    await f.publish(true)
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
    f.tasks.value = [task('running', 'other-branch')]
    await nextTick()
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
    await f.publish(false)
    expect(f.state.activities.value.get('task')).toBe('running')
    await f.publish(true)
    f.tasks.value = [task('awaiting_approval')]
    await nextTick()
    expect(f.state.activities.value.get('task')).toBe('awaiting_approval')
    f.tasks.value = [task()]
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
    f.tasks.value = [task('idle')]
    await nextTick()
    expect(f.state.activities.value.get('task')).toBe('idle')
  })

  it('discards stale responses after newer events, task removal and disposal', async () => {
    const f = fixture()
    const stale = deferred<LocalExecutionActivity>()
    f.activity.mockReturnValueOnce(stale.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    await f.publish(false)
    stale.resolve({ hasBlockingAnswer: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')

    const removed = deferred<LocalExecutionActivity>()
    f.activity.mockReturnValueOnce(removed.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    f.tasks.value = []
    await nextTick()
    f.tasks.value = [task()]
    await nextTick()
    removed.resolve({ hasBlockingAnswer: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')

    const disposed = deferred<LocalExecutionActivity>()
    f.activity.mockReturnValueOnce(disposed.promise)
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    f.scope.stop()
    disposed.resolve({ hasBlockingAnswer: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.activities.value.get('task')).toBe('running')
  })

  it('drops stale waiting state on a failed refresh and recovers on the next event', async () => {
    const f = fixture()
    await f.publish(true)
    f.activity.mockRejectedValueOnce(new Error('temporarily unavailable'))
    f.change()
    await vi.advanceTimersByTimeAsync(101)
    expect(f.state.activities.value.get('task')).toBe('running')
    expect(f.errors).toHaveLength(1)
    await f.publish(true)
    expect(f.state.activities.value.get('task')).toBe('awaiting_answer')
  })
})
