// @vitest-environment jsdom
import type { Component, PropType } from 'vue'
import type { WorkbenchView } from '../../common/workbench'
import { expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onUnmounted } from 'vue'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { WorkingCopyService } from '../../services/WorkingCopyService'
import { useWorkbench } from '../workbenchContext'
import WorkbenchHost from '../WorkbenchHost.vue'
import WorkbenchLayoutNode from '../WorkbenchLayoutNode.vue'

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
