// @vitest-environment jsdom
import type { Component } from 'vue'
import { join } from 'node:path'
import { LexoraConfigStore } from '@buddy-electron/main/config/LexoraConfigStore'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopNavigationLayoutSettings from '../DesktopNavigationLayoutSettings.vue'
import DesktopProxySettings from '../DesktopProxySettings.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mount(component: Component, props: () => Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    render: () => h(NMessageProvider, { duration: 0 }, { default: () => h(component, props()) }),
  })
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

describe('settings action feedback', () => {
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
  })

  it('keeps the saved navigation layout while pending or failed and saves a retry without changing sidebar preferences', async () => {
    const config = await configFixture()
    config.value.desktop.sidebarCollapsed = true
    config.value.desktop.taskSidebar = { collapsed: true, collapsedSections: ['tasks'], collapsedSpaces: ['space-a'], width: 336 }
    const legacy = structuredClone(config.value.desktop.taskSidebar)
    let finish = (_success: boolean) => {}
    const root = mount(DesktopNavigationLayoutSettings, () => ({
      config: config.value,
      error: null,
      language: 'zh-CN',
      updateSettings: (patch: { desktop: { navigationLayout: typeof config.value.desktop.navigationLayout } }) => new Promise<boolean>((resolve) => {
        finish = (success) => {
          if (success)
            config.value = { ...config.value, desktop: { ...config.value.desktop, ...patch.desktop } }
          resolve(success)
        }
      }),
    }))
    const choices = Array.from(root.querySelectorAll('label'))
    const choice = (name: string) => choices.find(label => label.textContent?.includes(name))!
    const checked = (name: string) => (choice(name).control as HTMLInputElement).checked
    expect(checked('全览')).toBe(true)

    choice('轻简').click()
    await nextTick()
    expect(checked('全览')).toBe(true)
    finish(false)
    await vi.waitFor(() => expect(messages()).toHaveLength(1))
    expect(checked('全览')).toBe(true)
    expect(checked('轻简')).toBe(false)

    choice('轻简').click()
    await nextTick()
    finish(true)
    await vi.waitFor(() => expect(checked('轻简')).toBe(true))
    expect(config.value.desktop.navigationLayout).toBe('compact')
    expect(config.value.desktop.sidebarCollapsed).toBe(true)
    expect(config.value.desktop.taskSidebar).toEqual(legacy)
  })
})
