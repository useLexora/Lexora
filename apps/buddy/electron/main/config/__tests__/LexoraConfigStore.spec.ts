import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../../shared/browser/browserPreferences'
import { DEFAULT_THEME_PREFERENCE } from '../../../../shared/theme/themePreferences'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '../../../shared/desktopApi'
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
  it('migrates paired themes into one selection while retaining system appearance tracking', async () => {
    for (const mode of ['light', 'dark', 'system'] as const) {
      const { configPath, store } = await createConfigStore()
      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(configPath, `[desktop.theme]\nmode="${mode}"\nlight="author.ocean.day"\ndark="author.ocean.night"\n[custom]\nkeep=true\n`)
      const expected = { id: mode === 'system' ? 'system' : mode === 'dark' ? 'author.ocean.night' : 'author.ocean.day' }
      expect((await store.read()).desktop.theme).toEqual(expected)
      await store.update({ desktop: { language: 'en-US' } })
      expect((await new LexoraConfigStore({ configPath }).read()).desktop.theme).toEqual(expected)
      const saved = await readFile(configPath, 'utf8')
      expect(saved).toContain('keep = true')
    }
  })

  it('migrates legacy theme choices and rejects an expired write without changing persisted settings', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\ntheme="dark"\naccent_color="violet"\n[custom]\nkeep=true\n')
    const original = await store.read()
    expect(original.desktop.theme).toEqual({ id: 'lexora.themes.violet-dark' })
    await store.update({ desktop: { language: 'en-US' } })
    const saved = await readFile(configPath, 'utf8')
    expect(saved).not.toContain('accent_color')
    expect(saved).toContain('keep = true')
    let expired = false
    await expect(store.update({ desktop: { theme: DEFAULT_THEME_PREFERENCE } }, () => {
      expired = true
    }, () => {
      if (expired)
        throw new Error('owner expired')
    })).rejects.toThrow('owner expired')
    expect(await readFile(configPath, 'utf8')).toBe(saved)
    expect(store.snapshot.applied?.desktop.theme).toEqual(original.desktop.theme)
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.theme).toEqual(original.desktop.theme)
  })

  it('enables pasted text attachments for new and legacy profiles and preserves an opt-out across updates and restart', async () => {
    const { configPath, store } = await createConfigStore()
    expect((await store.read()).desktop.chat.pasteTextAsAttachment).toBe(true)
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop.chat]\nwelcome = "none"\nfuture = true\n')
    expect((await store.read()).desktop.chat.pasteTextAsAttachment).toBe(true)
    await store.update({ desktop: { chat: { pasteTextAsAttachment: false } } })
    await store.update({ desktop: { chat: { outlinePosition: 'center-left' } } })
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat).toEqual({
      ...DEFAULT_DESKTOP_CHAT_PREFERENCES,
      outlinePosition: 'center-left',
      pasteTextAsAttachment: false,
      welcome: 'none',
    })
    const saved = await readFile(configPath, 'utf8')
    expect(saved).toContain('paste_text_as_attachment = false')
    expect(saved).toContain('future = true')
    await writeFile(configPath, '[desktop.chat]\npaste_text_as_attachment = "false"\n')
    await expect(store.read()).rejects.toThrow()
  })

  it('defaults existing profiles to three retries and round-trips disabled, finite and unlimited limits', async () => {
    const { store, configPath } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[runtime]\ncache_warming = "streaming"\nfuture = true\n')
    expect((await store.read()).runtime).toEqual({ cacheWarming: 'streaming', codemode: false, modelRetryLimit: 3 })
    for (const modelRetryLimit of [0, 7, 'unlimited'] as const) {
      await store.update({ runtime: { modelRetryLimit } })
      await store.update({ desktop: { language: 'en-US' } })
      expect((await new LexoraConfigStore({ configPath }).read()).runtime).toEqual({ cacheWarming: 'streaming', codemode: false, modelRetryLimit })
      expect(await readFile(configPath, 'utf8')).toContain('future = true')
    }
    const saved = await readFile(configPath, 'utf8')
    expect(saved).toContain('model_retry_limit = "unlimited"')
    for (const modelRetryLimit of [-1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 'invalid'] as const)
      await expect(store.update({ runtime: { modelRetryLimit: modelRetryLimit as never } })).rejects.toThrow()
    await expect(store.update({ runtime: { cacheWarming: 'idle' as never } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(saved)
  })

  it('persists permission mode, defaults legacy profiles, and rejects invalid values without a partial write', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop.chat]\nwelcome = "random"\n')
    expect((await store.read()).desktop.chat.permissionMode).toBe('policy_approval')

    await store.update({ desktop: { chat: { permissionMode: 'full_access' } } })
    expect(await readFile(configPath, 'utf8')).toContain('permission_mode = "full_access"')
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat.permissionMode).toBe('full_access')

    const saved = await readFile(configPath, 'utf8')
    await expect(store.update({ desktop: { chat: { permissionMode: 'invalid' as never } } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(saved)

    await writeFile(configPath, '[desktop.chat]\npermission_mode = "invalid"\n')
    await expect(store.read()).rejects.toThrow()
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
    await store.update({ desktop: { keybindings: { 'task.new': 'Mod+Alt+N', 'view.close': '' }, theme: { id: 'lexora.themes.classic-dark' } } })
    const reopened = new LexoraConfigStore({ configPath })
    expect((await reopened.read()).desktop.keybindings).toEqual({ 'task.new': 'Mod+Alt+N', 'view.close': '' })
    const before = await readFile(configPath, 'utf8')
    await expect(reopened.update({ desktop: { keybindings: { 'task.new': 'not a shortcut' } } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(before)
    await reopened.update({ desktop: { keybindings: {} } })
    expect((await reopened.read()).desktop).toMatchObject({ theme: { id: 'lexora.themes.classic-dark' }, keybindings: {} })
  })

  it('restores the applied configuration when applying a setting fails without changing the saved profile', async () => {
    const { store } = await createConfigStore()
    const previous = await store.read()
    const changes: string[] = []
    store.onDidChange(change => changes.push(change.kind))
    let active = previous.proxy
    await expect(store.update({ proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' } }, async (next) => {
      active = next.proxy
      if (next.proxy.mode === 'custom')
        throw new Error('Proxy configuration unavailable')
    })).rejects.toThrow('Proxy configuration unavailable')
    expect(active).toEqual(previous.proxy)
    expect(await store.read()).toEqual(previous)
    expect(changes).toEqual(['apply-failed', 'rolled-back'])
    expect(store.snapshot.applied).toEqual(previous)
  })
  it('preserves nested settings, ordered pins and unknown fields across partial updates and restart', async () => {
    const { configPath, store } = await createConfigStore()
    expect(await store.read()).toMatchObject({
      runtime: { cacheWarming: 'off' },
      proxy: { mode: 'system', server: '' },
      desktop: {
        theme: DEFAULT_THEME_PREFERENCE,
        contextPanelMode: 'task',
        contextPanelGlobal: false,
        updateNotificationsEnabled: true,
        profile: { userName: '', deviceName: '', avatar: '' },
        taskSidebar: { collapsed: false, collapsedSections: [], collapsedSpaces: [], width: null },
      },
      pet: { alwaysOnTop: true, enabled: true, rememberPosition: true },
    })
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[api]\nbase_url="https://lexora.example"\n[desktop]\nnotifications_enabled=false\nfuture_setting=true\n[desktop.chat]\nwelcome="none"\nfuture=true\n')
    const previous = await store.read()
    expect(previous.desktop.chat).toMatchObject({ outlinePosition: 'top-right', permissionMode: 'policy_approval', welcome: 'none' })
    expect(previous.desktop.updateNotificationsEnabled).toBe(true)
    const profile = { userName: 'Alice', deviceName: 'Alice-Laptop', avatar: 'data:image/png;base64,abc' }
    const taskSidebar = { collapsed: true, collapsedSections: ['tasks' as const], collapsedSpaces: ['space-a'], width: 336 }
    const taskSidebarPinnedItems = [{ id: 'space-a', kind: 'space' as const }, { id: 'conversation-a', kind: 'conversation' as const }]
    const updated = await store.update({
      runtime: { cacheWarming: 'streaming' },
      proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' },
      desktop: {
        theme: { id: 'lexora.themes.classic-dark' },
        chat: { welcome: 'writing' },
        contextPanelMode: 'space',
        contextPanelGlobal: true,
        updateNotificationsEnabled: false,
        profile,
        taskSidebar,
        taskSidebarPinnedItems,
      },
      pet: { alwaysOnTop: false, enabled: false, rememberPosition: false },
    })
    expect(updated).toEqual({
      ...previous,
      runtime: { ...previous.runtime, cacheWarming: 'streaming' },
      proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' },
      desktop: {
        ...previous.desktop,
        theme: { id: 'lexora.themes.classic-dark' },
        chat: { ...previous.desktop.chat, welcome: 'writing' },
        contextPanelMode: 'space',
        contextPanelGlobal: true,
        updateNotificationsEnabled: false,
        profile,
        taskSidebar,
        taskSidebarPinnedItems,
      },
      pet: { alwaysOnTop: false, enabled: false, rememberPosition: false },
    })
    await store.update({
      proxy: { mode: 'direct', server: 'http://127.0.0.1:7890' },
      desktop: { language: 'en-US', contextPanelGlobal: false, profile: { userName: 'Bob' }, taskSidebar: { collapsedSpaces: ['space-b'] } },
    })
    expect(await new LexoraConfigStore({ configPath }).read()).toEqual({
      ...updated,
      proxy: { mode: 'direct', server: 'http://127.0.0.1:7890' },
      desktop: {
        ...updated.desktop,
        language: 'en-US',
        contextPanelGlobal: false,
        profile: { ...profile, userName: 'Bob' },
        taskSidebar: { ...taskSidebar, collapsedSpaces: ['space-b'] },
      },
    })
    const content = await readFile(configPath, 'utf8')
    expect(content).toContain('base_url = "https://lexora.example"')
    expect(content).toContain('future_setting = true')
    expect(content).toContain('future = true')
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(dirname(configPath))).toEqual(['config.toml'])
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

it('persists an optional Unicode plugin signature without changing profile or previous data on invalid input', async () => {
  const { store, configPath } = await createConfigStore()
  expect((await store.read()).desktop.pluginAuthor).toBe('')
  await store.update({ desktop: { pluginAuthor: '山雨海 · Équipe 🎨', profile: { userName: '个人名称' } } })
  const saved = await readFile(configPath, 'utf8')
  const reopened = new LexoraConfigStore({ configPath })
  expect((await reopened.read()).desktop.pluginAuthor).toBe('山雨海 · Équipe 🎨')
  await expect(store.update({ desktop: { pluginAuthor: '名'.repeat(81) } })).rejects.toThrow()
  expect(await readFile(configPath, 'utf8')).toBe(saved)
  await store.update({ desktop: { pluginAuthor: '' } })
  expect((await reopened.read()).desktop.profile.userName).toBe('个人名称')
  expect((await reopened.read()).desktop.pluginAuthor).toBe('')
})
