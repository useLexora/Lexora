import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
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
      desktop: { theme: 'system', welcomeVariant: 'random' },
      pet: { alwaysOnTop: true, enabled: true, rememberPosition: true },
    })

    const updated = await store.update({
      desktop: {
        theme: 'dark',
        welcomeVariant: 'writing',
      },
      pet: { alwaysOnTop: false, enabled: false, rememberPosition: false },
    })

    expect(updated.desktop).toEqual({
      backgroundCloseNoticeShown: false,
      taskSidebarPinnedItems: [],
      developerToolsEnabled: false,
      language: 'zh-CN',
      launchAtLogin: false,
      notificationsEnabled: true,
      notifyWhenFocused: false,
      sidebarCollapsed: false,
      theme: 'dark',
      welcomeVariant: 'writing',
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
    expect(content).toContain('welcome_variant = "writing"')
    expect(content).not.toContain('[agent.codex]')
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)

    await expect(access(`${configPath}.tmp`, constants.F_OK)).rejects.toMatchObject({
      code: 'ENOENT',
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

  it('normalizes an unavailable welcome variant to random', async () => {
    const { configPath, store } = await createConfigStore()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[desktop]\nwelcome_variant = "listening"\n')

    await expect(store.read()).resolves.toMatchObject({
      desktop: { welcomeVariant: 'random' },
    })

    await store.update({ desktop: { theme: 'dark' } })
    expect(await readFile(configPath, 'utf8')).toContain('welcome_variant = "random"')
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
