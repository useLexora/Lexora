// @vitest-environment jsdom
import type { PropType } from 'vue'
import type { WorkbenchView } from '../../common/workbench'
import { AutoScroller, Feedback } from '@dnd-kit/dom'
import { expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onUnmounted, ref } from 'vue'
import { panes } from '../../common/workbench'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { WorkingCopyService } from '../../services/WorkingCopyService'
import WorkbenchMountPoint from '../mounts/WorkbenchMountPoint.vue'
import { ViewRendererRegistry } from '../ViewRendererRegistry'
import { useWorkbench } from '../workbenchContext'
import { createWorkbenchDragPlugins } from '../workbenchDragPlugins'
import WorkbenchHost from '../WorkbenchHost.vue'
import WorkbenchLayoutNode from '../WorkbenchLayoutNode.vue'
import WorkbenchPaneActions from '../WorkbenchPaneActions.vue'

vi.hoisted(() => {
  Element.prototype.scrollIntoView = () => {}
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

it('keeps a contributed view instance alive across splits, moves and missing contributions', async () => {
  let created = 0
  let disposed = 0
  const CustomView = defineComponent({
    props: { view: { type: Object as PropType<WorkbenchView>, required: true } },
    setup(props) {
      const identity = ++created
      onUnmounted(() => disposed++)
      return () => h('button', { 'data-instance': identity }, String(props.view.state.message ?? 'Preview'))
    },
  })
  const registry = new ContributionRegistry()
  const renderers = new ViewRendererRegistry()
  const register = () => registry.register('sample.preview', (scope) => {
    scope.cleanup(renderers.register('sample.preview', CustomView))
    scope.view({ locations: ['main'], id: 'sample.preview', renderer: 'sample.preview', label: 'Preview', supports: input => input.scheme === 'sample', multiple: true })
  })
  const unregister = register()
  const controller = new WorkbenchController(registry)
  const first = (await controller.open({ scheme: 'sample', id: 'one', data: {} }, 'Preview'))!
  controller.updateView(first, { state: { message: 'Saved view state' } })
  const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
    throw new Error('unused')
  } })
  const element = document.createElement('div')
  document.body.append(element)
  const Layout = defineComponent({ setup() {
    const { layout } = useWorkbench()
    return () => h(WorkbenchLayoutNode, { node: layout.value.root })
  } })
  const app = createApp({
    render: () => h(WorkbenchHost, { controller, copies, language: 'en-US', backupError: false, active: true, keybindings: {}, platform: 'linux' }, {
      default: () => h(Layout),
      view: ({ view }: { view: WorkbenchView }) => h(renderers.resolve(registry.views.get(view.type)!.renderer)!, { view }),
    }),
  })
  app.mount(element)
  try {
    await nextTick()
    const original = element.querySelector('[data-instance="1"]')!
    expect(original.textContent).toBe('Saved view state')
    await controller.open({ scheme: 'sample', id: 'two', data: {} }, 'Second', { direction: 'right' })
    const secondPane = controller.layout.activePane
    await nextTick()
    expect(created).toBe(2)
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    const previousPane = controller.pane(secondPane)!
    const replacement = await controller.open({ scheme: 'sample', id: 'three', data: {} }, 'Replacement', { paneId: secondPane })
    await nextTick()
    expect(created).toBe(3)
    expect(disposed).toBe(1)
    expect(controller.pane(secondPane)).not.toBe(previousPane)
    expect(previousPane.view).not.toBe(replacement)
    expect(element.querySelector('[data-instance="3"]')?.closest('[data-pane-id]')?.getAttribute('data-pane-id')).toBe(secondPane)
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    await controller.move(first, secondPane)
    await nextTick()
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    expect(original.closest('[data-pane-id]')?.getAttribute('data-pane-id')).toBe(secondPane)
    expect(disposed).toBe(2)
    controller.updateView(first, { state: { message: 'Updated view state' } })
    await nextTick()
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    expect(original.textContent).toBe('Updated view state')
    const saved = JSON.stringify(controller.layout)
    unregister()
    await nextTick()
    expect(disposed).toBe(3)
    expect(element.textContent).toContain('This view is unavailable')
    expect(JSON.stringify(controller.layout)).toBe(saved)
    register()
    await nextTick()
    expect(element.textContent).toContain('Updated view state')
    expect(created).toBe(4)
  }
  finally {
    app.unmount()
    registry.dispose()
    element.remove()
  }
  expect(disposed).toBe(created)
})

it('configures workbench drag plugins without AutoScroller to avoid scrolling conversation pages during drag', () => {
  const plugins = createWorkbenchDragPlugins()
  const pluginInstances = plugins.map(p => typeof p === 'object' && p !== null && 'plugin' in p ? (p as { plugin: unknown }).plugin : p)

  expect(pluginInstances).not.toContain(AutoScroller)
  expect(pluginInstances.some(p => typeof p === 'function' && p.name.includes('AutoScroller'))).toBe(false)
  const feedbackPlugin = plugins.find(p => typeof p === 'object' && p !== null && 'plugin' in p && (p as { plugin: unknown }).plugin === Feedback) as { options: { dropAnimation: null } } | undefined
  expect(feedbackPlugin).toBeDefined()
  expect(feedbackPlugin?.options.dropAnimation).toBeNull()
})

it.each(['right', 'down'] as const)('keeps both split axes resizable after collapsing and rebuilding a three-pane layout (%s)', async (direction) => {
  const registry = new ContributionRegistry()
  registry.register('sample', scope => scope.view({ locations: ['main'], id: 'sample', renderer: 'sample', label: 'Sample', supports: resource => resource.scheme === 'sample', multiple: true }))
  const controller = new WorkbenchController(registry)
  const open = (id: string, split?: 'right' | 'down') => controller.open({ scheme: 'sample', id, data: {} }, id, { direction: split })
  const first = (await open('first'))!
  await open('second', direction)
  await open('third', direction === 'right' ? 'down' : 'right')
  const root = controller.layout.root
  if (root.kind !== 'split' || root.second.kind !== 'split')
    throw new Error('Expected nested splits')
  const retainedSplitId = root.second.id
  const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
    throw new Error('unused')
  } })
  const element = document.createElement('div')
  document.body.append(element)
  const Layout = defineComponent({ setup() {
    const { layout } = useWorkbench()
    return () => h(WorkbenchLayoutNode, { node: layout.value.root })
  } })
  const app = createApp({
    render: () => h(WorkbenchHost, { controller, copies, language: 'en-US', backupError: false, active: true, keybindings: {}, platform: 'linux' }, {
      default: () => h(Layout),
      view: () => h('div'),
    }),
  })
  app.mount(element)
  try {
    await nextTick()
    await controller.close(first)
    await nextTick()
    expect(controller.layout.root.id).toBe(retainedSplitId)
    await open('fourth', direction)
    await nextTick()
    expect(panes(controller.layout.root)).toHaveLength(3)
    const handles = [...element.querySelectorAll<HTMLElement>('.workbench-split__handle')]
    expect(handles).toHaveLength(2)
    for (const handle of handles) {
      const split = handle.parentElement!
      vi.spyOn(split, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
      let captured: number | null = null
      Object.assign(handle, {
        setPointerCapture: (id: number) => captured = id,
        hasPointerCapture: (id: number) => captured === id,
        releasePointerCapture: () => captured = null,
      })
      const before = Number(handle.getAttribute('aria-valuenow'))
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 100, clientY: 100 }))
      await nextTick()
      expect(element.querySelector('.workbench__resize-shield')).not.toBeNull()
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 180, clientY: 180 }))
      await nextTick()
      expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      await nextTick()
      expect(element.querySelector('.workbench__resize-shield')).toBeNull()
      expect(captured).toBeNull()
      const beforeKey = Number(handle.getAttribute('aria-valuenow'))
      handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: split.classList.contains('horizontal') ? 'ArrowLeft' : 'ArrowUp' }))
      await nextTick()
      expect(Number(handle.getAttribute('aria-valuenow'))).toBe(beforeKey - 3)
    }
  }
  finally {
    app.unmount()
    registry.dispose()
    element.remove()
  }
})

it('hides close action in WorkbenchPaneActions when only a single pane exists', async () => {
  const registry = new ContributionRegistry()
  registry.register('sample.preview', scope => scope.view({ locations: ['main'], id: 'sample.preview', renderer: 'sample.preview', label: 'Preview', supports: input => input.scheme === 'sample', multiple: true }))
  const controller = new WorkbenchController(registry)
  const first = (await controller.open({ scheme: 'sample', id: 'one', data: {} }, 'Task 1'))!
  const copies = new WorkingCopyService({
    read: async () => ({ text: '', etag: '' }),
    save: async () => {
      throw new Error('unused')
    },
  })
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    render: () => h(WorkbenchHost, { controller, copies, language: 'zh-CN', backupError: false, active: true, keybindings: {}, platform: 'linux' }, {
      default: () => h(WorkbenchPaneActions, { viewId: first }),
      view: () => h('div'),
    }),
  })
  app.mount(element)
  try {
    await nextTick()
    expect(panes(controller.layout.root).length).toBe(1)

    // Open dropdown in single-pane mode
    const menuButton = element.querySelector<HTMLButtonElement>('[data-testid="pane-layout-menu"]')!
    menuButton.click()
    await nextTick()

    const singleLabels = [...document.querySelectorAll('.n-dropdown-option-body__label')].map(el => el.textContent?.trim())
    expect(singleLabels).toEqual(['向左分屏', '向右分屏', '向上分屏', '向下分屏'])
    expect(document.querySelector('.n-dropdown-divider')).toBeNull()

    // Split to 2 panes
    await controller.open({ scheme: 'sample', id: 'two', data: {} }, 'Task 2', { direction: 'right' })
    await nextTick()
    expect(panes(controller.layout.root).length).toBe(2)

    // Close previous popover and reopen dropdown in multi-pane mode
    document.body.click()
    await nextTick()
    menuButton.click()
    await nextTick()

    const multiLabels = [...document.querySelectorAll('.n-dropdown-option-body__label')].map(el => el.textContent?.trim())
    expect(multiLabels).toContain('关闭')
    expect(document.querySelector('.n-dropdown-divider')).not.toBeNull()
  }
  finally {
    app.unmount()
    registry.dispose()
    element.remove()
    document.querySelectorAll('.v-binder-follower-container').forEach(el => el.remove())
  }
})

it('preserves independent plugin content when changing mounts or removing the target', async () => {
  let created = 0
  let disposed = 0
  const CustomView = defineComponent({ setup() {
    const identity = ++created
    onUnmounted(() => disposed++)
    return () => h('input', { 'data-instance': identity })
  } })
  const registry = new ContributionRegistry()
  for (const id of ['first', 'second']) {
    registry.register(id, (scope) => {
      scope.view({ id, renderer: id, label: id, locations: ['mount'], supports: () => true, multiple: true })
      scope.placement({ id, viewType: id, location: 'mount', target: 'workbench', presentation: { position: 'absolute', left: 40, top: 60, width: 300, height: 150 } })
    })
  }
  const controller = new WorkbenchController(registry)
  const first = (await controller.open({ scheme: 'sample', id: 'first', data: {} }, 'First', { viewType: 'first', location: 'mount', placement: 'first' }))!
  const second = (await controller.open({ scheme: 'sample', id: 'second', data: {} }, 'Second', { viewType: 'second', location: 'mount', placement: 'second' }))!
  const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
    throw new Error('unused')
  } })
  const sidebar = ref(true)
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({ render: () => h(WorkbenchHost, { controller, copies, language: 'en-US', backupError: false, active: true, keybindings: {}, platform: 'linux' }, {
    default: () => [h(WorkbenchMountPoint, { target: 'workbench' }), sidebar.value ? h(WorkbenchMountPoint, { target: 'app.sidebar' }) : null],
    view: () => h(CustomView),
  }) })
  app.mount(element)
  try {
    await nextTick()
    const original = element.querySelector<HTMLInputElement>('[data-instance="1"]')!
    original.value = 'plugin-owned state'
    const surface = (id: string) => element.querySelector<HTMLElement>(`[data-mount-view="${id}"]`)!
    expect(surface(first).style.top).toBe('60px')
    expect(surface(second).style.top).toBe('60px')
    controller.updateView(first, { presentation: { target: 'app.sidebar', width: 48, height: 48 } })
    await nextTick()
    expect(original.closest('[data-mount-point]')?.getAttribute('data-mount-point')).toBe('app.sidebar')
    expect(surface(first).style.width).toBe('48px')
    expect(surface(second).style.width).toBe('300px')
    sidebar.value = false
    await nextTick()
    expect(original.closest('[hidden]')).not.toBeNull()
    sidebar.value = true
    await nextTick()
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    expect(original.value).toBe('plugin-owned state')
    expect(created).toBe(2)
    expect(disposed).toBe(0)
    await controller.close(first)
    await nextTick()
    expect(disposed).toBe(1)
  }
  finally {
    app.unmount()
    registry.dispose()
    element.remove()
  }
})

it('prepares a view inside its destination pane and reveals the same DOM without an empty intermediate layout', async () => {
  const registry = new ContributionRegistry()
  registry.register('sample', scope => scope.view({ id: 'sample', renderer: 'sample', locations: ['main'], label: 'Sample', supports: () => true, multiple: false, prepareBeforeOpen: true }))
  const controller = new WorkbenchController(registry)
  const original = (await controller.open({ scheme: 'sample', id: 'original', data: {} }, 'Original'))!
  const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
    throw new Error('unused')
  } })
  const element = document.createElement('div')
  document.body.append(element)
  const Layout = defineComponent({ setup() {
    const { layout } = useWorkbench()
    return () => h(WorkbenchLayoutNode, { node: layout.value.root })
  } })
  const app = createApp({
    render: () => h(WorkbenchHost, { controller, copies, language: 'en-US', backupError: false, active: true, keybindings: {}, platform: 'linux' }, {
      default: () => h(Layout),
      view: ({ view, visible }: { view: WorkbenchView, visible: boolean }) => h('input', { 'data-ready-view': view.id, 'data-visible': visible, 'value': view.title }),
    }),
  })
  app.mount(element)
  try {
    await nextTick()
    const originalNode = element.querySelector(`[data-ready-view="${original}"]`)!
    const opening = controller.open({ scheme: 'sample', id: 'next', data: {} }, 'Next')
    const candidate = controller.navigation.entries.get(controller.layout.activePane)!.view.id
    await nextTick()
    const preparedNode = element.querySelector(`[data-ready-view="${candidate}"]`)!
    const preparedSurface = preparedNode.closest('.workbench-surface')!
    expect(preparedSurface.classList.contains('is-preparing')).toBe(true)
    expect(preparedSurface.hasAttribute('inert')).toBe(true)
    expect(preparedNode.getAttribute('data-visible')).toBe('false')
    expect(preparedNode.closest('[data-pane-id]')).toBe(originalNode.closest('[data-pane-id]'))
    expect(originalNode.closest('.is-preparing')).toBeNull()
    controller.navigation.ready(candidate)
    await opening
    await nextTick()
    expect(element.querySelector(`[data-ready-view="${candidate}"]`)).toBe(preparedNode)
    expect(preparedNode.closest('.workbench-surface')).toBe(preparedSurface)
    expect(preparedSurface.classList.contains('is-preparing')).toBe(false)
    expect(preparedSurface.hasAttribute('inert')).toBe(false)
    expect(preparedNode.getAttribute('data-visible')).toBe('true')
    expect(element.contains(originalNode)).toBe(false)
  }
  finally {
    app.unmount()
    registry.dispose()
    element.remove()
  }
})
