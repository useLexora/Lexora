// @vitest-environment jsdom
import type { ModelPickerOption } from '../../../model/modelCatalog'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopModelSelect from '../DesktopModelSelect.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mountSelection(initial: string[], models: ModelPickerOption[], max = 5) {
  const root = document.createElement('div')
  root.className = 'buddy-app'
  document.body.append(root)
  const value = shallowRef(initial)
  const options = shallowRef(models)
  const app = createApp({
    setup: () => () => h(DesktopModelSelect, {
      'id': 'model-field',
      'aria-label': '补充模型',
      'modelValue': value.value,
      'models': options.value,
      'providers': [{ id: 'a', displayName: 'Service A' }, { id: 'b', displayName: 'Service B' }],
      'language': 'zh-CN',
      'multiple': true,
      max,
      'onUpdate:modelValue': (next: string[]) => { value.value = next },
    }),
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  const trigger = () => root.querySelector<HTMLButtonElement>('#model-field')!
  const choice = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find(button => button.textContent?.includes(name))!
  const action = (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  return { root, value, options, trigger, choice, action }
}

const models: ModelPickerOption[] = [
  { providerId: 'a', modelId: 'old', displayName: 'Old', disabled: true },
  { providerId: 'a', modelId: 'new', displayName: 'New' },
  { providerId: 'a', modelId: 'third', displayName: 'Third' },
]

describe('ordered model selection', () => {
  it('closes on Escape after focus leaves the popup and restores the trigger without dismissing lower layers', async () => {
    const ui = mountSelection(['a:old', 'a:new'], models)
    const keys: string[] = []
    const onKey = (event: KeyboardEvent) => {
      keys.push(event.key)
    }
    document.addEventListener('keydown', onKey)
    cleanups.push(() => document.removeEventListener('keydown', onKey))
    ui.trigger().click()
    await nextTick()
    ui.action('上移 New').focus()
    ui.action('上移 New').click()
    await nextTick()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    expect(ui.trigger().getAttribute('aria-expanded')).toBe('true')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(escape)
    await nextTick()
    expect(ui.trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(ui.trigger())
    expect(escape.defaultPrevented).toBe(true)
    expect(keys).toEqual([])
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(keys).toEqual(['Escape'])
  })

  it('preserves unavailable values, appends choices and supports reordering and removal', async () => {
    const ui = mountSelection(['a:old'], models)
    expect(ui.trigger().getAttribute('aria-label')).toBe('补充模型')
    expect(ui.trigger().textContent).toContain('Old')
    ui.trigger().click()
    await nextTick()
    expect(ui.choice('Old').disabled).toBe(false)
    ui.choice('New').click()
    await nextTick()
    expect(ui.value.value).toEqual(['a:old', 'a:new'])
    expect(ui.trigger().textContent).toContain('+1')
    expect(ui.trigger().getAttribute('aria-expanded')).toBe('true')
    ui.action('上移 New').click()
    await nextTick()
    expect(ui.value.value).toEqual(['a:new', 'a:old'])
    expect(ui.trigger().textContent).toContain('New')
    ui.options.value = models.filter(model => model.modelId !== 'old')
    await nextTick()
    expect(ui.value.value).toEqual(['a:new', 'a:old'])
    ui.action('移除 a:old').click()
    await nextTick()
    expect(ui.value.value).toEqual(['a:new'])
    expect(ui.trigger().textContent).not.toContain('+1')
  })

  it('enforces the limit without blocking deselection or changing order during search', async () => {
    const ui = mountSelection(['a:new', 'a:old'], models, 2)
    ui.trigger().click()
    await nextTick()
    expect(ui.choice('Third').disabled).toBe(true)
    const search = ui.root.querySelector<HTMLInputElement>('input')!
    search.value = 'Old'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(ui.value.value).toEqual(['a:new', 'a:old'])
    expect(ui.choice('Old').disabled).toBe(false)
    ui.choice('Old').click()
    await nextTick()
    expect(ui.value.value).toEqual(['a:new'])
    expect(ui.choice('Old').disabled).toBe(true)
    ui.action('清空选择').click()
    await nextTick()
    expect(ui.value.value).toEqual([])
  })
})
