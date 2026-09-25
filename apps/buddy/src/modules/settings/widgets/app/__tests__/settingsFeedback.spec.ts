// @vitest-environment jsdom
import type { Component } from 'vue'
import { join } from 'node:path'
import { LexoraConfigStore } from '@buddy-electron/main/config/LexoraConfigStore'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopAboutSettings from '../DesktopAboutSettings.vue'
import DesktopApplicationToggle from '../DesktopApplicationToggle.vue'
import DesktopProxySettings from '../DesktopProxySettings.vue'

const { checkForUpdates } = vi.hoisted(() => ({ checkForUpdates: vi.fn() }))
vi.mock('@/platform/desktop/desktopApi', () => ({ requireDesktopApi: () => ({ app: { checkForUpdates } }) }))
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mount(component: Component, props: () => Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(NMessageProvider, { duration: 0 }, { default: () => h(component, props()) }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return root
}

async function configFixture() {
  const directory = await createTemporaryDirectory('settings-feedback-')
  return shallowRef(await new LexoraConfigStore({ configPath: join(directory, 'config.toml') }).read())
}

function messages() {
  return Array.from(document.querySelectorAll('.n-message')).map(element => element.textContent)
}

function button(root: HTMLElement, label: string) {
  return Array.from(root.querySelectorAll('button')).find(element => element.textContent?.trim() === label)!
}

describe('settings action feedback', () => {
  it('shows one safe global message per failed update check and allows a successful retry', async () => {
    checkForUpdates.mockRejectedValue(new Error('fixture-private-endpoint'))
    const root = mount(DesktopAboutSettings, () => ({ appInfo: null, language: 'zh-CN' }))
    const control = button(root, '检查更新')
    expect(messages()).toEqual([])
    for (const count of [1, 2]) {
      control.click()
      await vi.waitFor(() => expect(messages()).toHaveLength(count))
      expect(root.textContent).not.toContain('暂时无法检查更新')
      expect(document.body.textContent).not.toContain('fixture-private-endpoint')
      expect(messages().every(message => message?.includes('暂时无法检查更新'))).toBe(true)
      expect(control.disabled).toBe(false)
    }
    checkForUpdates.mockResolvedValue({ status: 'up_to_date' })
    control.click()
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain('最新'))
    expect(messages()).toHaveLength(2)
  })

  it('keeps proxy validation inline, retains a failed draft, and saves it on retry', async () => {
    const config = await configFixture()
    config.value.proxy = { mode: 'custom', server: 'http://127.0.0.1:7777' }
    let succeeds = false
    const root = mount(DesktopProxySettings, () => ({
      config: config.value,
      error: null,
      language: 'zh-CN',
      updateSettings: async (patch: { proxy: typeof config.value.proxy }) => {
        if (succeeds)
          config.value = { ...config.value, proxy: patch.proxy }
        return succeeds
      },
    }))
    const input = root.querySelector<HTMLInputElement>('input[type="text"]')!
    const form = root.querySelector('form')!
    input.value = 'invalid'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(root.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    expect(messages()).toEqual([])
    input.value = 'http://127.0.0.1:8888'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(messages()).toHaveLength(1))
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(input.value).toBe('http://127.0.0.1:8888')
    expect(config.value.proxy.server).toBe('http://127.0.0.1:7777')
    succeeds = true
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(config.value.proxy.server).toBe('http://127.0.0.1:8888'))
    expect(messages()).toHaveLength(1)
  })

  it('keeps the saved toggle value on failure without adding a row, and can retry', async () => {
    const config = await configFixture()
    let succeeds = false
    const root = mount(DesktopApplicationToggle, () => ({
      config: config.value,
      error: null,
      language: 'zh-CN',
      field: 'developerToolsEnabled',
      label: '开发者工具',
      description: '',
      updateSettings: async (patch: { desktop: { developerToolsEnabled: boolean } }) => {
        if (succeeds)
          config.value = { ...config.value, desktop: { ...config.value.desktop, ...patch.desktop } }
        return succeeds
      },
    }))
    const control = root.querySelector<HTMLButtonElement>('[role="switch"]')!
    const children = root.firstElementChild!.childElementCount
    control.click()
    await vi.waitFor(() => expect(messages()).toHaveLength(1))
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(root.firstElementChild!.childElementCount).toBe(children)
    succeeds = true
    control.click()
    await vi.waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'))
    expect(messages()).toHaveLength(1)
  })
})
