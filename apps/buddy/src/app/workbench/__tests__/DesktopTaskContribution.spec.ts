import type { TaskCapability } from '@/modules/tasks'
// @vitest-environment jsdom
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import DesktopTaskContribution from '../DesktopTaskContribution.vue'
import { desktopWorkbenchKey } from '../desktopWorkbenchContext'

const mocks = vi.hoisted(() => ({ environment: undefined as unknown }))

vi.mock('@/shared/ui/useTaskErrorMessage', () => ({ useTaskErrorMessage: () => vi.fn() }))

vi.mock('@/modules/tasks', () => ({
  useTaskEnvironment: () => mocks.environment,
}))

vi.mock('@/modules/tasks/ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    DesktopTaskViewProvider: defineComponent({
      name: 'TestDesktopTaskViewProvider',
      props: { context: { type: Object, required: true } },
      setup: (_, { slots }) => () => h('div', { 'data-testid': 'task-provider' }, slots.default?.()),
    }),
    DesktopTaskEditor: defineComponent({
      name: 'TestDesktopTaskEditor',
      props: { active: Boolean, readingPositions: Object },
      emits: ['ready'],
      setup: (_, { slots, emit }) => () => h('div', { 'data-testid': 'task-editor' }, [
        slots.title?.(),
        slots.actions?.({ options: [], select: () => {}, label: 'actions' }),
        h('button', { 'data-testid': 'editor-ready', 'onClick': () => emit('ready') }, 'ready'),
      ]),
    }),
  }
})

vi.mock('@/workbench/browser/WorkbenchPaneTitle.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    name: 'TestWorkbenchPaneTitle',
    props: { view: { type: Object, required: true } },
    setup: props => () => h('span', { 'data-testid': 'pane-title' }, (props.view as WorkbenchView).title),
  }) }
})

vi.mock('@/workbench/browser/WorkbenchPaneActions.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    name: 'TestWorkbenchPaneActions',
    setup: () => () => h('span', { 'data-testid': 'pane-actions' }),
  }) }
})

vi.mock('naive-ui', async importOriginal => ({
  ...await importOriginal<typeof import('naive-ui')>(),
  useMessage: () => ({ error: vi.fn() }),
}))

afterEach(() => {
  vi.useRealTimers()
  mocks.environment = undefined
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createTask(id: string, loading: boolean) {
  const isLoading = shallowRef(loading)
  const activeTaskId = shallowRef<string | null>(id)
  const task = {
    workspace: {
      session: { activeBranchId: shallowRef('branch') },
      status: {
        isLoading,
        errorMessage: shallowRef<string | null>(null),
        dismissError: vi.fn(),
      },
    },
    session: {
      activeTaskId,
      currentTitle: shallowRef(`${id} title`),
      spaceId: shallowRef<string | null>(null),
      startTask: vi.fn(),
    },
  } as unknown as TaskCapability
  return { task, activeTaskId, isLoading }
}

function createHarness(
  open: (resource: WorkbenchView['resource']) => Promise<TaskCapability>,
  initialResource = { scheme: 'task', id: 'first', data: {} },
  title = 'First conversation',
) {
  const workbench = {
    controller: {
      registry: { commands: { get: () => undefined } },
      owner: () => ({ id: 'pane' }),
      commands: { execute: vi.fn() },
      navigation: { ready: vi.fn(), fail: vi.fn() },
      updateView: vi.fn(),
    },
    pool: { open: vi.fn(open) },
    language: shallowRef('en-US'),
    readingPositions: {},
    newTask: vi.fn(),
  }
  const view = shallowRef<WorkbenchView>({
    id: 'task-view',
    type: 'tasks.editor',
    location: 'main',
    resource: initialResource,
    title,
    state: {},
  })
  mocks.environment = { notificationTarget: shallowRef(null) }
  const runtime = {
    failed: shallowRef(false),
    loading: shallowRef(false),
    maintenance: shallowRef(null),
    language: shallowRef('en-US' as const),
    retry: vi.fn(async () => {}),
  }
  const element = document.createElement('div')
  const app = createApp({
    setup() {
      provide(runtimeAvailabilityKey, runtime)
      provide(desktopWorkbenchKey, workbench as never)
      provide(workbenchKey, { labels: shallowRef(workbenchLabels('en-US')) } as WorkbenchContext)
      return () => h(DesktopTaskContribution, { view: view.value, visible: true })
    },
  })
  app.mount(element)
  return { app, element, runtime, view, workbench }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('desktop task contribution loading handoff', () => {
  it('skips the loading body on quick opens, delays it on slow opens, and waits for first-screen readiness', async () => {
    vi.useFakeTimers()
    const first = createTask('first', false)
    const slowOpen = deferred<TaskCapability>()
    const finalOpen = deferred<TaskCapability>()
    const open = vi.fn((resource: WorkbenchView['resource']) => {
      if (resource.id === 'first')
        return Promise.resolve(first.task)
      if (resource.id === 'slow')
        return slowOpen.promise
      return finalOpen.promise
    })
    const f = createHarness(open)
    try {
      await settle()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
      expect(f.element.querySelector('[role="status"]')).toBeNull()
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(f.element.querySelector('[role="status"]')).toBeNull()

      f.view.value = { ...f.view.value, resource: { scheme: 'task', id: 'slow', data: {} }, title: 'Slow conversation' }
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-editor"]')).toBeNull()
      expect(f.element.querySelector('[data-testid="pane-title"]')?.textContent).toBe('Slow conversation')

      f.view.value = { ...f.view.value, resource: { scheme: 'task', id: 'final', data: {} }, title: 'Final conversation' }
      await nextTick()
      expect(open).toHaveBeenCalledTimes(3)
      expect(f.element.querySelector('[data-testid="pane-title"]')?.textContent).toBe('Final conversation')
      vi.advanceTimersByTime(179)
      await nextTick()
      expect(f.element.querySelector('[role="status"]')).toBeNull()
      vi.advanceTimersByTime(1)
      await nextTick()
      expect(f.element.querySelector('[role="status"]')?.textContent).toContain('Opening')
      expect(f.element.querySelector('.desktop-task-loading__progress-bar')).not.toBeNull()

      const stale = createTask('slow', false)
      slowOpen.resolve(stale.task)
      await settle()
      expect(f.element.querySelector('[data-testid="task-editor"]')).toBeNull()

      const final = createTask('final', true)
      finalOpen.resolve(final.task)
      await settle()
      expect(f.element.querySelector('[role="status"]')).not.toBeNull()
      final.isLoading.value = false
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
      expect(f.element.querySelector('[role="status"]')).toBeNull()
      f.element.querySelector<HTMLButtonElement>('[data-testid="editor-ready"]')!.click()
      expect(f.workbench.controller.navigation.ready).toHaveBeenCalledOnce()

      final.isLoading.value = true
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
      expect(f.element.querySelector('[data-testid="task-loading"]')).toBeNull()
    }
    finally {
      f.app.unmount()
    }
  })

  it('lets the editor handle runtime recovery during opening and still waits for first-screen readiness', async () => {
    const first = createTask('first', true)
    const f = createHarness(async () => first.task)
    try {
      await settle()
      expect(f.element.querySelector('[data-testid="task-loading"]')).not.toBeNull()
      f.runtime.failed.value = true
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
      f.runtime.failed.value = false
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-loading"]')).not.toBeNull()
      first.isLoading.value = false
      await nextTick()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
    }
    finally {
      f.app.unmount()
    }
  })

  it('keeps the mounted editor when a draft is adopted by its active conversation', async () => {
    const draft = createTask('draft', false)
    draft.activeTaskId.value = null
    const open = vi.fn().mockResolvedValue(draft.task)
    const f = createHarness(open, { scheme: 'draft', id: 'draft', data: {} }, 'Draft')
    try {
      await settle()
      const editor = f.element.querySelector('[data-testid="task-editor"]')
      expect(editor).not.toBeNull()

      draft.activeTaskId.value = 'adopted-conversation'
      f.view.value = {
        ...f.view.value,
        resource: { scheme: 'task', id: 'adopted-conversation', data: { branchId: 'branch' } },
        title: 'Adopted conversation',
      }
      await nextTick()
      expect(open).toHaveBeenCalledTimes(2)
      expect(f.element.querySelector('[data-testid="task-editor"]')).toBe(editor)
      expect(f.element.querySelector('[data-testid="pane-title"]')?.textContent).toBe('Adopted conversation')
      expect(f.element.querySelector('[data-testid="task-loading"]')).toBeNull()
    }
    finally {
      f.app.unmount()
    }
  })

  it('shows an open failure immediately and retries the active resource', async () => {
    vi.useFakeTimers()
    const retryTask = createTask('retry', false)
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('TASK_READ_FAILED'))
      .mockResolvedValueOnce(retryTask.task)
    const f = createHarness(open, { scheme: 'task', id: 'retry', data: {} }, 'Retry conversation')
    try {
      await settle()
      expect(f.element.querySelector('[role="alert"]')).not.toBeNull()
      expect(f.element.querySelector('[role="status"]')).toBeNull()
      expect(f.workbench.controller.navigation.fail).toHaveBeenCalledOnce()
      f.element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
      await settle()
      expect(f.element.querySelector('[data-testid="task-editor"]')).not.toBeNull()
      expect(open).toHaveBeenCalledTimes(2)
    }
    finally {
      f.app.unmount()
    }
  })
})
