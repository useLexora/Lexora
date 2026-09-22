// @vitest-environment jsdom
import type { Component, PropType } from 'vue'
import type { WorkbenchView } from '../../common/workbench'
import { AutoScroller, Feedback } from '@dnd-kit/dom'
import { expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onUnmounted } from 'vue'
import { panes } from '../../common/workbench'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { WorkingCopyService } from '../../services/WorkingCopyService'
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
  const register = () => registry.register('sample.preview', scope => scope.view({ id: 'sample.preview', label: 'Preview', supports: input => input.scheme === 'sample', multiple: true, factory: CustomView }))
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
      view: ({ view }: { view: WorkbenchView }) => h(registry.views.get(view.type)!.factory as Component, { view }),
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
    await controller.move(first, secondPane)
    await nextTick()
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    expect(original.closest('[data-pane-id]')?.getAttribute('data-pane-id')).toBe(secondPane)
    expect(disposed).toBe(1)
    controller.updateView(first, { state: { message: 'Updated view state' } })
    await nextTick()
    expect(element.querySelector('[data-instance="1"]')).toBe(original)
    expect(original.textContent).toBe('Updated view state')
    const saved = JSON.stringify(controller.layout)
    unregister()
    await nextTick()
    expect(disposed).toBe(2)
    expect(element.textContent).toContain('This view is unavailable')
    expect(JSON.stringify(controller.layout)).toBe(saved)
    register()
    await nextTick()
    expect(element.textContent).toContain('Updated view state')
    expect(created).toBe(3)
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

it('hides close action in WorkbenchPaneActions when only a single pane exists', async () => {
  const registry = new ContributionRegistry()
  registry.register('sample.preview', scope => scope.view({ id: 'sample.preview', label: 'Preview', supports: input => input.scheme === 'sample', multiple: true }))
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
