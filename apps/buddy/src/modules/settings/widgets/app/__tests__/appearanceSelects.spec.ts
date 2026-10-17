// @vitest-environment jsdom
import type { Component } from 'vue'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useProvideDesktopTheme } from '@/theme/useDesktopTheme'
import DesktopFileIconSettings from '../DesktopFileIconSettings.vue'
import DesktopThemeSettings from '../DesktopThemeSettings.vue'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
})

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

async function mount(component: Component) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      useProvideDesktopTheme()
      return () => h(NMessageProvider, null, { default: () => h(component, { language: 'zh-CN' }) })
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  return root
}

it.each([
  ['theme', DesktopThemeSettings],
  ['file icons', DesktopFileIconSettings],
] as const)('%s uses a plain select and toggles from the label instead of requiring the arrow', async (_name, component) => {
  const root = await mount(component)
  const selection = root.querySelector<HTMLElement>('.n-base-selection')!
  const label = root.querySelector<HTMLElement>('.n-base-selection-label')!
  expect(label).not.toBeNull()
  expect(root.querySelector('input')).toBeNull()
  expect(selection.classList.contains('n-base-selection--active')).toBe(false)
  label.click()
  await nextTick()
  expect(selection.classList.contains('n-base-selection--active')).toBe(true)
  label.click()
  await nextTick()
  expect(selection.classList.contains('n-base-selection--active')).toBe(false)
  selection.click()
  await nextTick()
  expect(selection.classList.contains('n-base-selection--active')).toBe(true)
  selection.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await nextTick()
  expect(selection.classList.contains('n-base-selection--active')).toBe(false)
})
