import type { LocalNotification } from '@buddy-shared/notifications/notificationApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DESKTOP_ROUTE_NAMES } from '@/shared/navigation/desktopRoutes'
import { useDesktopNavigation } from '../useDesktopNavigation'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

async function fixture(ready = Promise.resolve()) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { name: DESKTOP_ROUTE_NAMES.tasks, path: '/tasks', component: {} },
    { name: DESKTOP_ROUTE_NAMES.settingsApp, path: '/settings/app', component: {} },
    { name: DESKTOP_ROUTE_NAMES.settingsModels, path: '/settings/models', component: {} },
  ] })
  await router.push('/tasks')
  const activeTaskId = shallowRef<string | null>(null)
  const spaceId = shallowRef<string | null>(null)
  let version = 0
  const select = (id: string | null, space: string | null = null) => {
    version += 1
    activeTaskId.value = id
    spaceId.value = space
  }
  const markSeen = vi.fn(async (_value: LocalNotification) => true)
  const getRun = vi.fn(async (id: string) => ({ conversationId: id, branchId: `branch-${id}`, triggeringMessageId: `message-${id}` }))
  const activeBranchId = shallowRef<string | null>(null)
  const activateRunBranch = vi.fn(async (run: { branchId: string }) => {
    activeBranchId.value = run.branchId
    return true
  })
  const openTask = vi.fn(async (id: string, signal?: AbortSignal) => {
    if (!signal?.aborted)
      select(id)
  })
  const errors: unknown[] = []
  const scope = effectScope()
  scopes.push(scope)
  const navigation = scope.run(() => useDesktopNavigation({
    router,
    ready,
    getRun,
    activateRunBranch,
    notifications: { markSeen },
    onError: error => errors.push(error),
    session: { activeTaskId, spaceId, navigationVersion: () => version, openTask, startTask: async id => select(null, id) },
  }))!
  return { activeBranchId, activateRunBranch, activeTaskId, errors, getRun, markSeen, navigation, openTask, router, scope, select }
}

function notification(id: string): LocalNotification {
  return {
    id,
    revision: '1',
    attention: 'unseen',
    audience: 'device',
    lifecycle: 'resolved',
    origin: 'local-runtime',
    occurredAt: '2026-09-08T00:00:00.000Z',
    resolvedAt: '2026-09-08T00:00:00.000Z',
    kind: 'automation.run.completed',
    action: { type: 'open-conversation', conversationId: id, runId: id },
    payload: { automationId: id, automationName: id, errorCode: null },
  }
}

describe('desktop navigation intent', () => {
  it('opens the latest notification without waiting for mark-seen persistence', async () => {
    const f = await fixture()
    const marking = deferred<boolean>()
    f.markSeen.mockReturnValueOnce(marking.promise)
    await f.navigation.openNotification(notification('a'))
    await f.navigation.openNotification(notification('b'))
    marking.resolve(true)
    await nextTick()
    expect(f.activeTaskId.value).toBe('b')
    expect(f.navigation.notificationTarget.value).toEqual({ conversationId: 'b', messageId: 'message-b' })
  })

  it('keeps only the latest target queued during initialization', async () => {
    const ready = deferred<void>()
    const f = await fixture(ready.promise)
    const a = f.navigation.openTarget({ conversationId: 'a', runId: 'a' })
    const b = f.navigation.openTarget({ conversationId: 'b', runId: 'b' })
    ready.resolve()
    await Promise.all([a, b])
    expect(f.activeTaskId.value).toBe('b')
    expect(f.navigation.notificationTarget.value).toEqual({ conversationId: 'b', messageId: 'message-b' })
  })

  it.each(['route', 'task', 'dispose'])('cancels a queued target after a newer %s operation', async (operation) => {
    const ready = deferred<void>()
    const f = await fixture(ready.promise)
    const opening = f.navigation.openTarget({ conversationId: 'a', runId: 'a' })
    await nextTick()
    if (operation === 'route')
      await f.router.push('/settings/app')
    else if (operation === 'task')
      f.select('manual')
    else
      f.scope.stop()
    await nextTick()
    ready.resolve()
    await opening
    expect(f.activeTaskId.value).toBe(operation === 'task' ? 'manual' : null)
    expect(f.navigation.notificationTarget.value).toBeNull()
    expect(f.errors).toEqual([])
  })

  it('keeps the queued notification across automatic startup restoration', async () => {
    const ready = deferred<void>()
    const f = await fixture(ready.promise)
    const opening = f.navigation.openTarget({ conversationId: 'a', runId: 'a' })
    f.activeTaskId.value = 'restored'
    await nextTick()
    ready.resolve()
    await opening
    expect(f.activeTaskId.value).toBe('a')
    expect(f.navigation.notificationTarget.value).toEqual({ conversationId: 'a', messageId: 'message-a' })
  })

  it('discards an old run lookup after A to B to A selection', async () => {
    const f = await fixture()
    const run = deferred<{ conversationId: string, branchId: string, triggeringMessageId: string }>()
    f.getRun.mockReturnValueOnce(run.promise)
    const a = f.navigation.openTask('a', 'a')
    await vi.waitFor(() => expect(f.activeTaskId.value).toBe('a'))
    await f.navigation.openTask('b')
    await f.navigation.openTask('a')
    run.resolve({ conversationId: 'a', branchId: 'old-branch', triggeringMessageId: 'old-message' })
    await a
    expect(f.activeTaskId.value).toBe('a')
    expect(f.navigation.notificationTarget.value).toBeNull()
    expect(f.activeBranchId.value).toBeNull()
  })

  it('reveals the notification message only after its branch has loaded', async () => {
    const f = await fixture()
    const loading = deferred<boolean>()
    f.activateRunBranch.mockImplementationOnce(async (run) => {
      await loading.promise
      f.activeBranchId.value = run.branchId
      return true
    })
    f.activeBranchId.value = 'another-branch'
    const opening = f.navigation.openNotification(notification('a'))
    await vi.waitFor(() => expect(f.activeTaskId.value).toBe('a'))
    expect(f.navigation.notificationTarget.value).toBeNull()
    loading.resolve(true)
    await opening
    expect(f.activeBranchId.value).toBe('branch-a')
    expect(f.navigation.notificationTarget.value).toEqual({ conversationId: 'a', messageId: 'message-a' })
  })

  it('does not highlight a message when branch activation is unavailable', async () => {
    const f = await fixture()
    f.activeBranchId.value = 'running-branch'
    f.activateRunBranch.mockResolvedValueOnce(false)
    await f.navigation.openNotification(notification('a'))
    expect(f.activeBranchId.value).toBe('running-branch')
    expect(f.navigation.notificationTarget.value).toBeNull()
  })

  it('does not highlight an old branch after a newer navigation', async () => {
    const f = await fixture()
    const loading = deferred<boolean>()
    f.activateRunBranch.mockReturnValueOnce(loading.promise)
    const opening = f.navigation.openNotification(notification('a'))
    await vi.waitFor(() => expect(f.activateRunBranch).toHaveBeenCalled())
    await f.navigation.openTask('b')
    loading.resolve(true)
    await opening
    expect(f.activeTaskId.value).toBe('b')
    expect(f.navigation.notificationTarget.value).toBeNull()
  })

  it('aborts a pending task lookup when the user leaves the task route', async () => {
    const f = await fixture()
    const load = deferred<void>()
    let signal: AbortSignal | undefined
    f.openTask.mockImplementationOnce(async (id, currentSignal) => {
      signal = currentSignal
      await load.promise
      if (!signal?.aborted)
        f.select(id)
    })
    const opening = f.navigation.openTask('a')
    await vi.waitFor(() => expect(signal).toBeDefined())
    await f.router.push('/settings/models')
    load.resolve()
    await opening
    expect(signal?.aborted).toBe(true)
    expect(f.activeTaskId.value).toBeNull()
    expect(f.router.currentRoute.value.path).toBe('/settings/models')
  })
})
