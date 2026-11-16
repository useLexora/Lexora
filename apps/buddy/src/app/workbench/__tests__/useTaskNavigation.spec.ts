import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { TaskWorkspaceResource } from '../taskResource'
import type { TaskCapability } from '@/modules/tasks'
import type { SplitDirection } from '@/workbench/common/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { computed, effectScope, shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { panes, resourceKey } from '@/workbench/common/workbench'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { draftResource, taskResource } from '../taskResource'
import { TaskWorkspacePool } from '../TaskWorkspacePool'
import { useTaskNavigation } from '../useTaskNavigation'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const registry = new ContributionRegistry()
  registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: resource => ['task', 'draft'].includes(resource.scheme), multiple: false }))
  let navigation: ReturnType<typeof useTaskNavigation>
  const controller = new WorkbenchController(registry, view => navigation.prepareClose(view))
  const api = { localChat: {
    conversations: {
      get: async (id: string) => ({ id, activeBranchId: `${id}-main`, spaceId: null, deletedAt: null }),
      listBranches: async (id: string) => [`${id}-main`, `${id}-fork`].map(branchId => ({ id: branchId, conversationId: id })),
    },
  } } as unknown as LexoraDesktopApi
  const created: TaskCapability[] = []
  const disposed = new Set<TaskCapability>()
  const draftText = shallowRef('unsent input')
  const pool = new TaskWorkspacePool({
    conversations: api.localChat.conversations,
    index: { ensureConversation: async () => {}, applyConversation: () => {} },
    createTask: ({ initialTarget }) => {
      const task = {
        initialize: async () => {},
        dispose: () => disposed.add(task),
        workspace: {
          restoration: { state: shallowRef('ready') },
          session: { activeConversationId: shallowRef(initialTarget.conversationId), activeBranchId: shallowRef(initialTarget.branchId) },
          composer: { hasUnsentContent: computed(() => !!draftText.value) },
        },
      } as unknown as TaskCapability
      created.push(task)
      return task
    },
  }, (previous, _task, resource) => {
    for (const view of Object.values(controller.layout.views)) {
      if (resourceKey(view.resource) === resourceKey(previous))
        controller.updateView(view.id, { resource })
    }
  }, async () => {})
  const subscription = controller.onDidChangeLayout(() => pool.retain(controller.renderedViews.map(view => view.resource)))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks', component: {} }] })
  await router.push('/tasks')
  const errors: unknown[] = []
  const decisions = { replacement: 'cancel' as 'cancel' | 'discard' | 'split', discard: false }
  const scope = effectScope()
  navigation = scope.run(() => useTaskNavigation({
    api,
    controller,
    pool,
    router,
    center: () => controller.layout.activePane,
    chooseReplacement: async () => decisions.replacement,
    confirmDiscard: async () => decisions.discard,
    onError: error => errors.push(error),
  }))!
  cleanups.push(async () => {
    scope.stop()
    subscription.dispose()
    await controller.dispose()
    registry.dispose()
    pool.dispose()
    expect(errors).toEqual([])
  })
  async function open(resource: TaskWorkspaceResource, direction?: SplitDirection) {
    await navigation.activateTask(resource, resource.id, { direction })
    return controller.context.view!.id
  }
  return { controller, pool, navigation, open, created, disposed, decisions, draftText }
}

describe('task navigation resource identity', () => {
  it.each(['left', 'right', 'up', 'down'] as const)('moves an opened history task to the %s edge without replacing its view or workspace', async (direction) => {
    const f = await fixture()
    const resource = taskResource('a', 'a-fork')
    const source = await f.open(resource)
    const original = f.pool.peek(resource)
    f.controller.updateView(source, { state: { readingAnchor: 'message-1' } })
    const oldPane = f.controller.owner(source)!.id
    const other = await f.open(taskResource('b'), 'right')
    const targetPane = f.controller.owner(other)!.id
    f.controller.setAuxiliary('taskBranches', { a: 'a-main' })

    await f.navigation.activateTask(taskResource('a'), 'a', { paneId: targetPane, direction, move: true })

    expect(Object.keys(f.controller.layout.views).sort()).toEqual([source, other].sort())
    expect(f.controller.context.view?.id).toBe(source)
    expect(f.controller.layout.views[source]?.resource).toEqual(resource)
    expect(f.controller.layout.views[source]?.state).toEqual({ readingAnchor: 'message-1' })
    expect(f.controller.pane(oldPane)).toBeNull()
    expect(panes(f.controller.layout.root)).toHaveLength(2)
    expect(f.pool.peek(resource)).toBe(original)
    expect(f.created).toHaveLength(2)
    expect(f.disposed.has(original!)).toBe(false)
  })

  it('moves the original view into the center and closes only the replaced task', async () => {
    const f = await fixture()
    const resource = taskResource('a', 'a-fork')
    const source = await f.open(resource)
    const original = f.pool.peek(resource)
    const replaced = await f.open(taskResource('b'), 'right')
    const replacedTask = f.pool.peek(f.controller.layout.views[replaced]!.resource)!
    const targetPane = f.controller.owner(replaced)!.id

    await f.navigation.activateTask(taskResource('a'), 'a', { paneId: targetPane, move: true })

    expect(Object.keys(f.controller.layout.views)).toEqual([source])
    expect(f.controller.pane(targetPane)?.view).toBe(source)
    expect(panes(f.controller.layout.root)).toHaveLength(1)
    expect(f.pool.peek(resource)).toBe(original)
    expect(f.disposed).toEqual(new Set([replacedTask]))
    expect(f.created).toHaveLength(2)
  })

  it('preserves both panes and the unsent draft when discarding the replacement is cancelled', async () => {
    const f = await fixture()
    const resource = taskResource('a', 'a-fork')
    const source = await f.open(resource)
    const draft = await f.open(draftResource('draft'), 'right')
    const before = structuredClone(f.controller.layout)

    await f.navigation.activateTask(taskResource('a'), 'a', { paneId: f.controller.owner(draft)!.id, move: true })

    expect(f.controller.layout).toEqual(before)
    expect(f.draftText.value).toBe('unsent input')
    expect(f.disposed.size).toBe(0)
    expect(f.created).toHaveLength(2)
    expect(f.controller.layout.views[source]?.resource).toEqual(resource)

    f.decisions.discard = true
    await f.navigation.activateTask(taskResource('a'), 'a', { paneId: f.controller.owner(draft)!.id, move: true })
    expect(Object.keys(f.controller.layout.views)).toEqual([source])
    expect(f.controller.context.view?.id).toBe(source)
    expect(f.pool.peek(resource)).toBe(f.created[0])
  })

  it('uses the active branch for history opening and dragging when several branches are visible', async () => {
    const f = await fixture()
    const main = await f.open(taskResource('a', 'a-main'))
    const fork = await f.open(taskResource('a', 'a-fork'), 'right')
    const other = await f.open(taskResource('b'), 'right')
    const targetPane = f.controller.owner(other)!.id
    f.controller.focus(fork)
    f.controller.setAuxiliary('taskBranches', { a: 'a-main' })

    await f.navigation.activateTask(taskResource('a'), 'a')
    expect(f.controller.context.view?.id).toBe(fork)
    await f.navigation.activateTask(taskResource('a'), 'a', { paneId: targetPane, direction: 'down', move: true })

    expect(f.controller.context.view?.id).toBe(fork)
    expect(f.controller.layout.views[main]?.resource).toEqual(taskResource('a', 'a-main'))
    expect(f.controller.layout.views[fork]?.resource).toEqual(taskResource('a', 'a-fork'))
    expect(Object.keys(f.controller.layout.views)).toHaveLength(3)
    expect(f.created).toHaveLength(3)
  })

  it('keeps explicit branch dragging independent of the active branch and local memory', async () => {
    const f = await fixture()
    const main = await f.open(taskResource('a', 'a-main'))
    const other = await f.open(taskResource('b'), 'right')
    const targetPane = f.controller.owner(other)!.id
    f.controller.setAuxiliary('taskBranches', { a: 'a-main' })
    f.controller.focus(main)

    await f.navigation.activateTask(taskResource('a', 'a-fork'), 'a fork', { paneId: targetPane, direction: 'right', move: true })
    const fork = f.controller.context.view!.id
    expect(fork).not.toBe(main)
    expect(f.controller.layout.views[fork]?.resource).toEqual(taskResource('a', 'a-fork'))
    f.controller.focus(main)
    await f.navigation.activateTask(taskResource('a', 'a-fork'), 'a fork', { paneId: targetPane, direction: 'down', move: true })

    expect(f.controller.context.view?.id).toBe(fork)
    expect(f.controller.layout.views[main]?.resource).toEqual(taskResource('a', 'a-main'))
    expect(f.pool.peek(taskResource('a', 'a-fork'))).not.toBe(f.pool.peek(taskResource('a', 'a-main')))
    expect(Object.keys(f.controller.layout.views)).toHaveLength(3)
    expect(f.created).toHaveLength(3)
  })

  it.each([false, true])('opens a closed task on the locally remembered branch (move: %s)', async (move) => {
    const f = await fixture()
    f.controller.setAuxiliary('taskBranches', { a: 'a-fork' })

    await f.navigation.activateTask(taskResource('a'), 'a', { move })

    expect(f.controller.context.view?.resource).toEqual(taskResource('a', 'a-fork'))
    expect(f.pool.peek(taskResource('a', 'a-fork'))?.workspace.session.activeBranchId.value).toBe('a-fork')
    expect(f.created).toHaveLength(1)
  })

  it.each(['cancel', 'split', 'discard'] as const)('honors the %s decision when a history task would replace an unsent draft', async (replacement) => {
    const f = await fixture()
    const draft = await f.open(draftResource('draft'))
    f.controller.setAuxiliary('taskBranches', { a: 'a-fork' })
    f.decisions.replacement = replacement

    await f.navigation.activateTask(taskResource('a'), 'a', { move: true })

    expect(!!f.controller.layout.views[draft]).toBe(replacement !== 'discard')
    expect(Object.keys(f.controller.layout.views)).toHaveLength(replacement === 'split' ? 2 : 1)
    expect(f.controller.context.view?.resource).toEqual(replacement === 'cancel' ? draftResource('draft') : taskResource('a', 'a-fork'))
    expect(f.created).toHaveLength(replacement === 'cancel' ? 1 : 2)
  })
})
