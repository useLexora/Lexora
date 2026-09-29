// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopPluginSettingField from '../DesktopPluginSettingField.vue'

it('preserves a text draft through condition recalculation and resets it only at the save boundary', async () => {
  const disabled = shallowRef(false)
  const saving = shallowRef(false)
  const saved = shallowRef('saved')
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(DesktopPluginSettingField, {
    item: { id: 'tests.editor.name', key: 'name', group: 'settings.general.general', type: 'string', title: 'Name', description: '', default: '', order: 0 },
    value: saved.value,
    disabled: disabled.value,
    saving: saving.value,
    invalid: false,
    models: [],
    providers: [],
    language: 'zh-CN',
  }) })
  app.mount(root)
  try {
    const input = root.querySelector('input')!
    input.value = 'unfinished draft'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    disabled.value = true
    await nextTick()
    disabled.value = false
    await nextTick()
    expect(input.value).toBe('unfinished draft')
    saving.value = true
    await nextTick()
    saved.value = 'committed'
    saving.value = false
    await nextTick()
    expect(input.value).toBe('committed')
  }
  finally {
    app.unmount()
    root.remove()
  }
})
