import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../../shared/browser/browserPreferences'
import { DESKTOP_CHAT_OUTLINE_POSITIONS } from '../../../shared/desktopApi'
import { LexoraConfigStore } from '../LexoraConfigStore'

async function createConfigStore() {
  const directory = await createTemporaryDirectory('lexora-config-test-')
  const configPath = join(directory, '.lexora', 'config.toml')

  return {
    configPath,
    store: new LexoraConfigStore({ configPath }),
  }
}

describe('lexoraConfigStore', () => {
  it('defaults existing profiles to the upper right and persists every outline position without changing other settings', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\ntheme = "dark"\nwelcome_variant = "writing"\n[custom]\nkeep = true\n')
    const original = await store.read()
    expect(original.desktop.chat).toEqual({ outlinePosition: 'top-right', welcome: 'random' })
    await store.update({ desktop: { chat: { welcome: 'none' } } })
    for (const outlinePosition of DESKTOP_CHAT_OUTLINE_POSITIONS) {
      await store.update({ desktop: { chat: { outlinePosition } } })
      const restored = await new LexoraConfigStore({ configPath }).read()
      expect(restored).toEqual({
        ...original,
        desktop: { ...original.desktop, chat: { outlinePosition, welcome: 'none' } },
      })
      expect(await readFile(configPath, 'utf8')).toContain('keep = true')
    }
  })

  it('migrates browser preferences with defaults and preserves unrelated settings across updates', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\nlanguage = "en-US"\n[browser]\nfuture = true\n')
    expect((await store.read()).browser).toEqual(DEFAULT_BROWSER_PREFERENCES)
    await store.update({ browser: { screenshotDestination: 'clipboard' } })
    await store.update({ browser: { defaultZoomFactor: 1.25 } })
    await store.update({ browser: { freezeForeground: true, freezeDelaySeconds: 120 } })
    await store.update({ browser: { freezeBackground: false } })
    const restarted = new LexoraConfigStore({ configPath })
    expect((await restarted.read()).browser).toEqual({ ...DEFAULT_BROWSER_PREFERENCES, screenshotDestination: 'clipboard', defaultZoomFactor: 1.25, freezeBackground: false, freezeForeground: true, freezeDelaySeconds: 120 })
    expect((await restarted.read()).desktop.language).toBe('en-US')
    expect(await readFile(configPath, 'utf8')).toContain('future = true')
    const saved = await readFile(configPath, 'utf8')
    await expect(store.update({ browser: { defaultZoomFactor: 0 } })).rejects.toThrow()
    for (const freezeDelaySeconds of [0, 4, 3601, 10.5])
      await expect(store.update({ browser: { freezeDelaySeconds } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(saved)
  })

  it('persists shortcut overrides, disabled commands and reset without losing unrelated settings', async () => {
    const { store, configPath } = await createConfigStore()
    expect((await store.read()).desktop.keybindings).toEqual({})
    await store.update({ desktop: { keybindings: { 'task.new': 'Mod+Alt+N', 'view.close': '' }, theme: 'dark' } })
    const reopened = new LexoraConfigStore({ configPath })
    expect((await reopened.read()).desktop.keybindings).toEqual({ 'task.new': 'Mod+Alt+N', 'view.close': '' })
    const before = await readFile(configPath, 'utf8')
    await expect(reopened.update({ desktop: { keybindings: { 'task.new': 'not a shortcut' } } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(before)
    await reopened.update({ desktop: { keybindings: {} } })
    expect((await reopened.read()).desktop).toMatchObject({ theme: 'dark', keybindings: {} })
  })

  it('defaults existing profiles to system proxy and preserves the custom address across mode changes', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\nlanguage = "en-US"\n[future]\nvalue = true\n')
    expect((await store.read()).proxy).toEqual({ mode: 'system', server: '' })
    await store.update({ proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' } })
    await store.update({ proxy: { mode: 'direct', server: 'http://127.0.0.1:7890' } })
    expect((await store.read()).proxy).toEqual({ mode: 'direct', server: 'http://127.0.0.1:7890' })
    expect(await readFile(configPath, 'utf8')).toContain('[future]')
    expect((await store.read()).desktop.language).toBe('en-US')
  })

  it('defaults global panels off and persists mode and visibility independently across restarts', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\nlanguage = "en-US"\n[future]\nvalue = true\n')
    expect((await store.read()).desktop).toMatchObject({ contextPanelMode: 'task', contextPanelGlobal: false })
    await store.update({ desktop: { contextPanelMode: 'independent', contextPanelGlobal: true } })
    await store.update({ desktop: { theme: 'dark' } })
    const restarted = new LexoraConfigStore({ configPath })
    expect((await restarted.read()).desktop).toMatchObject({
      contextPanelMode: 'independent',
      contextPanelGlobal: true,
      language: 'en-US',
      theme: 'dark',
    })
    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('context_panel_global = true')
    expect(content).toContain('[future]')
    expect((await restarted.update({ desktop: { contextPanelMode: 'task' } })).desktop)
      .toMatchObject({ contextPanelMode: 'task', contextPanelGlobal: true })
    expect((await restarted.update({ desktop: { contextPanelGlobal: false } })).desktop)
      .toMatchObject({ contextPanelMode: 'task', contextPanelGlobal: false })
  })

  it('restores the applied configuration when applying a setting fails without changing the saved profile', async () => {
    const { store } = await createConfigStore()
    const previous = await store.read()
    let active = previous.proxy
    await expect(store.update({ proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' } }, async (next) => {
      active = next.proxy
      if (next.proxy.mode === 'custom')
        throw new Error('Proxy configuration unavailable')
    })).rejects.toThrow('Proxy configuration unavailable')
    expect(active).toEqual(previous.proxy)
    expect(await store.read()).toEqual(previous)
  })
  it('updates only requested settings and writes a private TOML file atomically', async () => {
    const { configPath, store } = await createConfigStore()
    await expect(store.read()).resolves.toMatchObject({
      desktop: { theme: 'system', chat: { outlinePosition: 'top-right', welcome: 'random' } },
      pet: { alwaysOnTop: true, enabled: true, rememberPosition: true },
    })

    const updated = await store.update({
      desktop: {
        theme: 'dark',
        chat: { welcome: 'writing' },
      },
      pet: { alwaysOnTop: false, enabled: false, rememberPosition: false },
    })

    expect(updated.desktop).toEqual({
      contextPanelMode: 'task',
      contextPanelGlobal: false,
      keybindings: {},
      backgroundCloseNoticeShown: false,
      chat: { outlinePosition: 'top-right', welcome: 'writing' },
      taskSidebarPinnedItems: [],
      taskSidebar: {
        collapsed: false,
        collapsedSections: [],
        collapsedSpaces: [],
        width: null,
      },
      developerToolsEnabled: false,
      language: 'zh-CN',
      launchAtLogin: false,
      notificationsEnabled: true,
      notifyWhenFocused: false,
      sidebarCollapsed: false,
      theme: 'dark',
    })
    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('[desktop]')
    expect(content).toContain('[pet]')
    expect(content).toContain('always_on_top = false')
    expect(content).toContain('enabled = false')
    expect(content).toContain('remember_position = false')
    await expect(store.read()).resolves.toEqual(updated)
    expect(content).toContain('background_close_notice_shown = false')
    expect(content).toContain('task_sidebar_pinned_items = []')
    expect(content).toContain('developer_tools_enabled = false')
    expect(content).toContain('launch_at_login = false')
    expect(content).toContain('notifications_enabled = true')
    expect(content).toContain('notify_when_focused = false')
    expect(content).toContain('sidebar_collapsed = false')
    expect(content).toContain('[desktop.chat]')
    expect(content).toContain('welcome = "writing"')
    expect(content).not.toContain('[agent.codex]')
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)

    await expect(access(`${configPath}.tmp`, constants.F_OK)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores the task sidebar layout preferences across restarts', async () => {
    const { configPath, store } = await createConfigStore()

    await expect(store.read()).resolves.toMatchObject({
      desktop: {
        taskSidebar: {
          collapsed: false,
          collapsedSections: [],
          collapsedSpaces: [],
          width: null,
        },
      },
    })

    await store.update({
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks'],
          collapsedSpaces: ['space-a'],
          width: 336,
        },
      },
    })

    const restarted = new LexoraConfigStore({ configPath })
    await expect(restarted.read()).resolves.toMatchObject({
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks'],
          collapsedSpaces: ['space-a'],
          width: 336,
        },
      },
    })
    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('task_sidebar')
    expect(content).toContain('collapsed = true')
    expect(content).toContain('collapsed_sections')
    expect(content).toContain('"tasks"')
    expect(content).toContain('collapsed_spaces')
    expect(content).toContain('"space-a"')
    expect(content).toContain('width = 336')

    await expect(store.update({
      desktop: { taskSidebar: { collapsedSpaces: ['space-b'] } },
    })).resolves.toMatchObject({
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks'],
          collapsedSpaces: ['space-b'],
          width: 336,
        },
      },
    })
  })

  it('persists the ordered top-level task sidebar pins', async () => {
    const { configPath, store } = await createConfigStore()

    await expect(store.update({
      desktop: {
        taskSidebarPinnedItems: [
          { id: 'space-a', kind: 'space' },
          { id: 'conversation-a', kind: 'conversation' },
        ],
      },
    })).resolves.toMatchObject({
      desktop: {
        taskSidebarPinnedItems: [
          { id: 'space-a', kind: 'space' },
          { id: 'conversation-a', kind: 'conversation' },
        ],
      },
    })

    await expect(store.read()).resolves.toMatchObject({
      desktop: {
        taskSidebarPinnedItems: [
          { id: 'space-a', kind: 'space' },
          { id: 'conversation-a', kind: 'conversation' },
        ],
      },
    })
    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('[[desktop.task_sidebar_pinned_items]]')
    expect(content).toContain('kind = "space"')
    expect(content).toContain('id = "conversation-a"')
  })

  it('uses defaults for omitted chat preferences and preserves unknown preferences on updates', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop.chat]\nwelcome = "none"\nfuture = true\n')

    await expect(store.read()).resolves.toMatchObject({
      desktop: { chat: { outlinePosition: 'top-right', welcome: 'none' } },
    })

    await store.update({ desktop: { theme: 'dark' } })
    const saved = await readFile(configPath, 'utf8')
    expect(saved).toContain('welcome = "none"')
    expect(saved).toContain('future = true')
  })

  it('preserves config sections owned by future or remote capabilities', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[api]\nbase_url = "https://lexora.example"\n\n[desktop]\ntheme = "system"\nfuture_setting = true\n')

    await store.update({ desktop: { theme: 'dark' } })

    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('[api]')
    expect(content).toContain('base_url = "https://lexora.example"')
    expect(content).toContain('future_setting = true')
  })

  it('rejects malformed TOML with a stable configuration error', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop\ntheme = "dark"')

    await expect(store.read()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    })
  })
})
