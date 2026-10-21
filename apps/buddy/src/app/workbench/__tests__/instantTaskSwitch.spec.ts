import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { TaskCapability, UseTaskCapabilityOptions } from '@/modules/tasks'
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
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { ActiveTaskProjection } from '../ActiveTaskProjection'
import { registerDesktopContributions } from '../registerDesktopContributions'
import { TaskWorkspacePool } from '../TaskWorkspacePool'
import { useTaskInputLifecycle } from '../useTaskInputLifecycle'

vi.mock('../DesktopTaskContribution.vue', () => ({ default: {} }))
vi.mock('../DesktopFileContribution.vue', () => ({ default: {} }))
const factory = vi.hoisted(() => ({ create: (_options: unknown): unknown => null }))
vi.mock('@/modules/tasks', () => ({ useTaskCapability: (options: unknown) => factory.create(options) }))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const gate = deferred<void>()
  let delayed = false
  let failed = false
  let canClose = true
  const initialized = new Set<string>()
  const failures = new Set<string>()
  const errors: unknown[] = []
  factory.create = (raw) => {
    const options = raw as UseTaskCapabilityOptions
    const id = options.initialTarget.conversationId!
    const state = shallowRef('ready')
    return {
      initialize: async () => {
        initialized.add(id)
        if (id === 'b' && delayed)
          await gate.promise
        if (id === 'b' && failed)
          throw new Error('TASK_READ_FAILED')
      },
      dispose: () => {},
      prepareClose: async () => canClose,
      cancelClose: () => {},
      session: { activeTaskId: shallowRef(id), spaceId: shallowRef(null) },
      workspace: { restoration: { state }, session: { activeConversationId: shallowRef(id) } },
    } as unknown as TaskCapability
  }
  const api = { localChat: {
    conversations: { get: async (id: string) => ({ id, activeBranchId: `${id}-branch`, spaceId: null, deletedAt: null }) },
    composerDrafts: {},
  } } as unknown as LexoraDesktopApi
  const index = { data: {
    conversations: shallowRef(['a', 'b', 'c'].map(id => ({ id }))),
    applyConversation: () => {},
    refreshConversations: async () => {},
  } }
  const pool = new TaskWorkspacePool({ api, index } as unknown as Omit<UseTaskCapabilityOptions, 'initialTarget'>, () => {}, async () => {})
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
  expect(controller.configuration.get('files.autoSave')).toBe('afterDelay')
  inputs = useTaskInputLifecycle({ api, controller, pool, persistence: {} as WorkbenchPersistence, resources: () => ({}) as TaskResourcePanel, onError: error => errors.push(error) })
  const projection = new ActiveTaskProjection(controller, pool)
  const loads = new Map<string, Promise<TaskCapability | null>>()
  function render() {
    pool.retain(controller.renderedViews.map(view => view.resource))
    for (const view of controller.renderedViews) {
      if (!loads.has(view.id)) {
        loads.set(view.id, pool.open(view.resource).catch(() => {
          failures.add(view.resource.id)
          return null
        }))
      }
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
  return { controller, pool, projection, gate, initialized, failures, errors, loads, open, first, delay: () => {
    delayed = true
  }, fail: () => {
    failed = true
  }, vetoClose: () => {
    canClose = false
  } }
}

describe('instant task switching', () => {
  it('selects the target immediately and supersedes its load without allowing the late result to replace the next task', async () => {
    const f = await fixture()
    f.delay()
    const b = (await f.open('b'))!
    await vi.waitFor(() => expect(f.initialized.has('b')).toBe(true))
    expect(f.projection.taskId.value).toBe('b')
    expect(f.projection.current.value).toBeNull()
    expect(f.pool.peek({ scheme: 'task', id: 'b', data: {} })).toBeUndefined()
    expect(f.controller.layout.views[f.first]).toBeUndefined()
    const c = (await f.open('c'))!
    await f.loads.get(c)
    expect(f.projection.current.value?.session.activeTaskId.value).toBe('c')
    f.gate.resolve()
    expect(await f.loads.get(b)).toBeNull()
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
    expect(navigation.notificationTarget.value).toEqual({ conversationId: 'b', messageId: 'target-message' })
  })
})
