// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { useWorkbenchLaunchers } from '../useWorkbenchLaunchers'
import WorkbenchResourcePanel from '../WorkbenchResourcePanel.vue'

it('uses the same registered launcher list for the empty state and add menu, including withdrawal and disabled dispatch', async () => {
  Element.prototype.scrollIntoView = () => {}
  const registry = new ContributionRegistry()
  const controller = new WorkbenchController(registry)
  const selected: string[] = []
  registry.register('base', (scope) => {
    scope.command({ id: 'browser.open', label: 'Browser', execute() {} })
    scope.command({ id: 'disabled.open', label: 'Unavailable', enabled: () => false, execute() {} })
    scope.launcher({ id: 'browser', command: 'browser.open', label: 'Browser', icon: 'browser', order: -1 })
    scope.launcher({ id: 'disabled', command: 'disabled.open', label: 'Unavailable' })
  })
  const remove = registry.register('plugin', (scope) => {
    scope.command({ id: 'plugin.player.open', label: 'Player', execute() {} })
    scope.launcher({ id: 'plugin.player', command: 'plugin.player.open', label: 'Player', icon: { url: 'data:image/png;base64,a' } })
  })
  const active = shallowRef<string | null>(null)
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      const { actions } = useWorkbenchLaunchers(controller)
      return () => h(WorkbenchResourcePanel, { activeTabId: active.value, tabs: active.value ? [{ id: 'open', title: 'Open' }] : [], actions: actions.value, language: 'en-US', onAdd: id => selected.push(id) })
    },
  })
  app.mount(element)
  try {
    const empty = [...element.querySelectorAll<HTMLButtonElement>('[data-testid^="task-context-open-"]')]
    expect(empty.map(button => button.textContent)).toEqual(['Browser', 'Unavailable', 'Player'])
    empty[1]!.click()
    empty[2]!.click()
    expect(selected).toEqual(['plugin.player'])
    active.value = 'open'
    await nextTick()
    element.querySelector<HTMLButtonElement>('[data-testid="context-add-tab"]')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3))
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(menu.map(button => button.textContent)).toEqual(empty.map(button => button.textContent))
    expect(menu[1]!.disabled).toBe(true)
    menu[1]!.click()
    expect(selected).toEqual(['plugin.player'])
    remove()
    await nextTick()
    expect([...document.querySelectorAll('[role="menuitem"]')].map(button => button.textContent)).toEqual(['Browser', 'Unavailable'])
    active.value = null
    await nextTick()
    expect([...element.querySelectorAll('[data-testid^="task-context-open-"]')].map(button => button.textContent)).toEqual(['Browser', 'Unavailable'])
  }
  finally {
    app.unmount()
    element.remove()
  }
})

it('retains a resource surface while switching through an empty task scope', async () => {
  Element.prototype.scrollIntoView = () => {}
  const Surface = defineComponent({
    setup() {
      const expanded = shallowRef(false)
      return () => h('button', { 'data-directory-toggle': '', 'onClick': () => expanded.value = !expanded.value }, expanded.value ? 'Expanded directory' : 'Collapsed directory')
    },
  })
  const active = shallowRef<string | null>('files')
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({ render: () => h(WorkbenchResourcePanel, { activeTabId: active.value, tabs: active.value ? [{ id: 'files', title: 'Files' }] : [], actions: [], language: 'en-US' }, { default: () => h(Surface) }) })
  app.mount(element)
  try {
    element.querySelector<HTMLButtonElement>('[data-directory-toggle]')!.click()
    active.value = null
    await nextTick()
    expect(element.querySelector<HTMLElement>('[role="tabpanel"]')!.style.display).toBe('none')
    active.value = 'files'
    await nextTick()
    expect(element.querySelector<HTMLElement>('[role="tabpanel"]')!.style.display).not.toBe('none')
    expect(element.querySelector('[data-directory-toggle]')!.textContent).toBe('Expanded directory')
  }
  finally {
    app.unmount()
    element.remove()
  }
})
