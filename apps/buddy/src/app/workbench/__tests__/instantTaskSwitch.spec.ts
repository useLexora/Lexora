import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { ShallowRef } from 'vue'
import type { TaskWorkspaceCreationOptions } from '../TaskWorkspacePool'
import type { TaskCapability } from '@/modules/tasks'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useDesktopNavigation } from '@/app/bootstrap/useDesktopNavigation'
import { DESKTOP_ROUTE_NAMES } from '@/shared/navigation/desktopRoutes'
import { ViewRendererRegistry } from '@/workbench/browser/ViewRendererRegistry'
import { resourceKey } from '@/workbench/common/workbench'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { ActiveTaskProjection } from '../ActiveTaskProjection'
import { registerDesktopContributions } from '../registerDesktopContributions'
import { TaskWorkspacePool } from '../TaskWorkspacePool'
import { useTaskInputLifecycle } from '../useTaskInputLifecycle'

vi.mock('../DesktopTaskContribution.vue', () => ({ default: {} }))
vi.mock('../DesktopFileContribution.vue', () => ({ default: {} }))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const gate = deferred<void>()
  let delayed = false
  let failed = false
  let canClose = true
  let restoredState: 'ready' | 'conflict' | 'failed' = 'ready'
  const restorationStates = new Map<string, ShallowRef<string>>()
  const disposed = new Set<string>()
  const initialized = new Set<string>()
  const errors: unknown[] = []
  const createTask = (options: TaskWorkspaceCreationOptions): TaskCapability => {
    const id = options.initialTarget.conversationId!
    const state = shallowRef(id === 'b' ? restoredState : 'ready')
    restorationStates.set(id, state)
    return {
      initialize: async () => {
        initialized.add(id)
        if (id === 'b' && delayed)
          await gate.promise
        if (id === 'b' && failed)
          throw new Error('TASK_READ_FAILED')
      },
      dispose: () => { disposed.add(id) },
      prepareClose: async () => canClose,
      cancelClose: () => {},
      session: { activeTaskId: shallowRef(id), spaceId: shallowRef(null), currentTitle: shallowRef(id) },
      workspace: { restoration: { state }, session: { activeConversationId: shallowRef(id), activeBranchId: shallowRef(options.initialTarget.branchId) } },
    } as unknown as TaskCapability
  }
  const api = { localChat: {
    conversations: { get: async (id: string) => ({ id, activeBranchId: `${id}-branch`, spaceId: null, deletedAt: null }), listBranches: async (id: string) => [`${id}-branch`, `${id}-fork`].map(branchId => ({ id: branchId, conversationId: id })) },
    composerDrafts: {},
  } } as unknown as LexoraDesktopApi
  const index = { data: {
    conversations: shallowRef(['a', 'b', 'c'].map(id => ({ id }))),
    applyConversation: () => {},
    ensureConversation: async () => {},
  } }
  let inputs: ReturnType<typeof useTaskInputLifecycle>
  const controller = new WorkbenchController(new ContributionRegistry(), async (view) => {
    try {
      return await inputs.prepareClose(view)
    }
    catch (error) {
      errors.push(error)
      return false
    }
  })
  registerDesktopContributions(controller, new ViewRendererRegistry(), {} as WorkingCopyService, () => 'en-US')
  const pool = new TaskWorkspacePool({ conversations: api.localChat.conversations, index: index.data, createTask }, (previous, _task, resource) => {
    for (const view of Object.values(controller.layout.views)) {
      if (resourceKey(view.resource) === resourceKey(previous))
        controller.updateView(view.id, { resource })
    }
  }, async () => {})
  inputs = useTaskInputLifecycle({ api, controller, pool, persistence: {} as WorkbenchPersistence, resources: () => ({}) as TaskResourcePanel, onError: error => errors.push(error) })
  const projection = new ActiveTaskProjection(controller, pool)
  const loads = new Map<string, Promise<TaskCapability | null>>()
  function render() {
    pool.retain(controller.renderedViews.map(view => view.resource))
    for (const view of controller.renderedViews) {
      if (!loads.has(view.id))
        loads.set(view.id, pool.open(view.resource).catch(() => null))
    }
  }
  const subscription = controller.onDidChangeLayout(render)
  const open = (id: string) => controller.open({ scheme: 'task', id, data: {} }, id)
  const first = (await open('a'))!
  await loads.get(first)
  cleanups.push(async () => {
    gate.resolve()
    subscription.dispose()
    projection.dispose()
    await controller.dispose()
    controller.registry.dispose()
    pool.dispose()
  })
  return { api, controller, pool, projection, gate, initialized, errors, loads, open, first, disposed, restorationStates, restoreAs: (state: typeof restoredState) => {
    restoredState = state
  }, delay: () => {
    delayed = true
  }, fail: () => {
    failed = true
  }, vetoClose: () => {
    canClose = false
  } }
}

describe('instant task switching', () => {
  it('keeps two branch views independent and pins legacy task layouts to the locally opened branch', async () => {
    const f = await fixture()
    expect(f.controller.layout.views[f.first]?.resource).toEqual({ scheme: 'task', id: 'a', data: { branchId: 'a-branch' } })
    const original = f.pool.peek({ scheme: 'task', id: 'a', data: { branchId: 'a-branch' } })!
    const resource = { scheme: 'task', id: 'a', data: { branchId: 'a-fork' } }
    const view = (await f.controller.open(resource, 'a fork', { direction: 'right' }))!
    await f.loads.get(view)
    const fork = f.pool.peek(resource)!
    expect(fork).not.toBe(original)
    expect(original.workspace.session.activeBranchId.value).toBe('a-branch')
    expect(fork.workspace.session.activeBranchId.value).toBe('a-fork')
    expect(await f.pool.open(resource)).toBe(fork)
    f.pool.retain([...f.controller.renderedViews.map(view => view.resource), { scheme: 'task', id: 'a', data: { branchId: 'missing' } }])
    await expect(f.pool.open({ scheme: 'task', id: 'a', data: { branchId: 'missing' } })).rejects.toThrow('TASK_BRANCH_UNAVAILABLE')
    expect(f.pool.peek(resource)).toBe(fork)
  })

  it('restores legacy and explicit views of the same branch without replacing its capability', async () => {
    const f = await fixture()
    f.delay()
    const legacy = { scheme: 'task', id: 'b', data: {} }
    const pinned = { scheme: 'task', id: 'b', data: { branchId: 'b-branch' } }
    f.pool.retain([...f.controller.renderedViews.map(view => view.resource), legacy, pinned])
    const oldView = f.pool.open(legacy)
    const branchView = f.pool.open(pinned)
    await vi.waitFor(() => expect(f.initialized.has('b')).toBe(true))
    f.gate.resolve()
    const [oldTask, branchTask] = await Promise.all([oldView, branchView])
    expect(oldTask).toBe(branchTask)
    expect(f.pool.peek(pinned)).toBe(branchTask)
    expect(oldTask.workspace.session.activeBranchId.value).toBe('b-branch')
    f.pool.retain([...f.controller.renderedViews.map(view => view.resource), legacy, pinned])
    expect(await f.pool.open(legacy)).toBe(branchTask)
  })

  it('retains a conflicted branch view for recovery and activates it when its draft is resolved', async () => {
    const f = await fixture()
    f.restoreAs('conflict')
    const resource = { scheme: 'task', id: 'b', data: { branchId: 'b-fork' } }
    const view = (await f.controller.open(resource, 'b fork'))!
    const task = await f.loads.get(view)
    expect(task).not.toBeNull()
    expect(task?.workspace.session.activeBranchId.value).toBe('b-fork')
    expect(task?.workspace.restoration.state.value).toBe('conflict')
    expect(f.pool.peek(resource)).toBe(task)
    expect(f.disposed.has('b')).toBe(false)
    expect(f.projection.taskId.value).toBe('b')
    expect(f.projection.current.value).toBeNull()

    f.restorationStates.get('b')!.value = 'ready'
    expect(f.projection.current.value).toBe(task)
    expect(await f.pool.open(resource)).toBe(task)
    expect(f.controller.layout.views[view]?.resource).toEqual(resource)
  })

  it('rejects an unavailable initial draft instead of treating it as a recoverable conflict', async () => {
    const f = await fixture()
    f.restoreAs('failed')
    const view = (await f.open('b'))!
    expect(await f.loads.get(view)).toBeNull()
    expect(f.pool.peek(f.controller.layout.views[view]!.resource)).toBeUndefined()
    expect(f.disposed.has('b')).toBe(true)
    expect(f.projection.current.value).toBeNull()
  })

  it('selects the target immediately and supersedes its load without allowing the late result to replace the next task', async () => {
    const f = await fixture()
    f.delay()
    const b = (await f.open('b'))!
    await vi.waitFor(() => expect(f.initialized.has('b')).toBe(true))
    expect(f.projection.taskId.value).toBe('b')
    expect(f.projection.current.value).toBeNull()
    expect(f.controller.layout.views[f.first]).toBeUndefined()
    const c = (await f.open('c'))!
    await f.loads.get(c)
    expect(f.projection.current.value?.session.activeTaskId.value).toBe('c')
    f.gate.resolve()
    await f.loads.get(b)
    expect(f.projection.taskId.value).toBe('c')
    expect(f.projection.current.value?.session.activeTaskId.value).toBe('c')
  })

  it('can leave an initialization failure without retrying it as a close prerequisite', async () => {
    const f = await fixture()
    f.fail()
    const b = (await f.open('b'))!
    expect(await f.loads.get(b)).toBeNull()
    expect(f.projection.taskId.value).toBe('b')
    const c = await f.open('c')
    expect(c).not.toBeNull()
    expect(f.controller.context.view?.resource.id).toBe('c')
    expect(f.errors).toEqual([])
  })

  it('keeps an initialized task when its unsaved input vetoes closure', async () => {
    const f = await fixture()
    f.vetoClose()
    expect(await f.open('b')).toBeNull()
    expect(f.controller.context.view?.id).toBe(f.first)
    expect(f.projection.current.value?.session.activeTaskId.value).toBe('a')
  })

  it('keeps notification branch and message targeting through the loading state', async () => {
    const f = await fixture()
    f.delay()
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { name: DESKTOP_ROUTE_NAMES.tasks, path: '/tasks', component: {} },
    ] })
    await router.push('/tasks')
    let version = 0
    const branch = shallowRef('current-branch')
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const navigation = scope.run(() => useDesktopNavigation({
      router,
      ready: Promise.resolve(),
      notifications: { markSeen: async () => true },
      openUpdate: async () => {},
      onError: error => f.errors.push(error),
      getRun: async () => ({ conversationId: 'b', branchId: 'notified-branch', triggeringMessageId: 'target-message' }),
      activateRunBranch: async (run) => {
        branch.value = run.branchId
        return true
      },
      session: {
        activeTaskId: f.projection.taskId,
        spaceId: computed(() => f.projection.current.value?.session.spaceId.value ?? null),
        navigationVersion: () => version,
        startTask: async () => {},
        openTask: async (id, signal) => {
          version += 1
          const resource = { scheme: 'task', id, data: {} }
          const viewId = await f.controller.open(resource, id, { signal })
          if (viewId && !signal?.aborted)
            await f.pool.open(resource)
        },
      },
    }))!
    const opening = navigation.openTarget({ conversationId: 'b', runId: 'run' })
    await vi.waitFor(() => expect(f.initialized.has('b')).toBe(true))
    expect(f.projection.taskId.value).toBe('b')
    f.gate.resolve()
    await opening
    expect(branch.value).toBe('notified-branch')
    expect(navigation.notificationTarget.value).toEqual({ conversationId: 'b', branchId: 'notified-branch', messageId: 'target-message' })
  })
})
