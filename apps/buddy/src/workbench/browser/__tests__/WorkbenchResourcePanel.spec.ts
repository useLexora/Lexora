// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import WorkbenchResourcePanel from '../WorkbenchResourcePanel.vue'

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
