// @vitest-environment jsdom
import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { SettingsContext } from '../../../settingsContext'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { builtinSettings } from '../../../model/builtinSettings'
import { settingsModuleLocation } from '../../../model/settingsNavigation'
import { useProvideSettingsContext } from '../../../settingsContext'
import { useSettingsRegistry } from '../../../state/useSettingsRegistry'
import DesktopSettingsSidebar from '../DesktopSettingsSidebar.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

const moduleId = 'tests.settings.module'

function plugin(experimental = true): ExtensionStatus {
  return {
    manifest: extensionManifestSchema.parse({
      schemaVersion: 1,
      id: 'tests.settings',
      name: 'Settings',
      version: '1.0.0',
      apiVersion: 3,
      engines: { lexora: '*' },
      contributes: { settings: { modules: [{
        id: moduleId,
        title: '本地模型',
        section: 'integrations',
        ...(experimental ? { experimental: { platforms: ['darwin'] } } : {}),
      }] } },
    }),
    revision: 'first',
    enabled: true,
    compatible: true,
    development: false,
    pending: null,
    state: 'active',
    generation: null,
    error: null,
    activationMs: null,
    logs: [],
  }
}

async function mountSidebar(platform: DesktopAppInfo['platform'] | null, experimental = true) {
  const appInfo = shallowRef(platform ? { platform } : null)
  const installed = shallowRef([plugin(experimental)])
  const language = shallowRef<BuddyLocale>('zh-CN')
  const component = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: `/plugins/${moduleId}` },
      ...builtinSettings.modules.map(module => ({ path: `/${module.id}`, name: settingsModuleLocation(module).name, component })),
      { path: '/plugins/:moduleId', name: 'desktop.settings.plugin', component },
    ],
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ setup() {
    const registry = useSettingsRegistry(installed)
    useProvideSettingsContext({ registry, appInfo } as unknown as SettingsContext)
    return () => h(DesktopSettingsSidebar, { appSidebarCollapsed: false, language: language.value, capabilities: null })
  } })
  app.use(router)
  await router.push({ name: 'desktop.settings.plugin', params: { moduleId } })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  const entry = () => root.querySelector<HTMLAnchorElement>(`a[href="/plugins/${moduleId}"]`)!
  return { root, appInfo, installed, language, entry }
}

const badgeSelector = '[data-testid="settings-experimental-tag"]'

describe('settings experimental entry', () => {
  it.each(['linux', 'win32', null] as const)('keeps the entry unmarked on %s', async (platform) => {
    const { root, entry } = await mountSidebar(platform)
    expect(entry().textContent).toBe('本地模型')
    expect(entry().getAttribute('aria-current')).toBe('page')
    expect(entry().hasAttribute('aria-describedby')).toBe(false)
    expect(root.querySelector(badgeSelector)).toBeNull()
    entry().focus()
    entry().dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('.n-tooltip, [role="tooltip"]')).toBeNull()
  })

  it('keeps undeclared entries unmarked on macOS', async () => {
    const { root, entry } = await mountSidebar('darwin', false)
    expect(root.querySelector(badgeSelector)).toBeNull()
    expect(entry().hasAttribute('aria-describedby')).toBe(false)
  })

  it('shows only one entry tag without tooltip, extra description or a new tab stop', async () => {
    const { root, entry, language } = await mountSidebar('darwin')
    const link = entry()
    expect(root.querySelectorAll(badgeSelector)).toHaveLength(1)
    expect(link.textContent).toBe('本地模型实验性')
    expect(link.querySelector('[tabindex], button, a')).toBeNull()
    expect(link.hasAttribute('aria-describedby')).toBe(false)
    link.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('.n-tooltip, [role="tooltip"]')).toBeNull()
    link.focus()
    await nextTick()
    expect(document.activeElement).toBe(link)
    expect(link.textContent).toBe('本地模型实验性')
    expect(document.querySelector('.n-tooltip, [role="tooltip"]')).toBeNull()
    language.value = 'en-US'
    await nextTick()
    expect(link.textContent).toBe('本地模型Experimental')
    expect(document.activeElement).toBe(link)
  })

  it('updates late platform and declaration changes and preserves existing plugin admission', async () => {
    const { root, entry, appInfo, installed } = await mountSidebar(null)
    appInfo.value = { platform: 'darwin' }
    await nextTick()
    expect(root.querySelectorAll(badgeSelector)).toHaveLength(1)
    installed.value = [plugin(false)]
    await nextTick()
    expect(root.querySelector(badgeSelector)).toBeNull()
    expect(entry().textContent).toBe('本地模型')
    for (const change of [{ enabled: false }, { compatible: false }, { state: 'blocked' as const }]) {
      installed.value = [{ ...plugin(), ...change }]
      await nextTick()
      expect(entry()).toBeNull()
    }
    installed.value = [plugin()]
    await nextTick()
    expect(root.querySelectorAll(badgeSelector)).toHaveLength(1)
    appInfo.value = { platform: 'linux' }
    await nextTick()
    expect(root.querySelector(badgeSelector)).toBeNull()
    expect(entry().textContent).toBe('本地模型')
  })
})
