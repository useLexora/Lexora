import type { LexoraConfigPatch } from '../../../shared/desktopApi'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../../shared/browser/browserPreferences'
import { DEFAULT_TYPOGRAPHY } from '../../../../shared/typography/typographyPreferences'
import { LexoraConfigStore } from '../LexoraConfigStore'

const welcomePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aU1cAAAAASUVORK5CYII='
const welcomeGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

async function createConfigStore(content?: string) {
  const directory = await createTemporaryDirectory('lexora-config-test-')
  const configPath = join(directory, '.lexora', 'config.toml')
  if (content !== undefined) {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, content)
  }
  return { configPath, store: new LexoraConfigStore({ configPath }) }
}

describe('lexoraConfigStore', () => {
  it('defaults legacy welcome images and preserves selections and animated GIF bytes across partial writes and restarts', async () => {
    const { store, configPath } = await createConfigStore('[desktop.chat]\nwelcome_companion_enabled=false\nfuture=true\n')
    expect((await store.read()).desktop.chat).toMatchObject({ welcomeCompanionEnabled: false, welcomeCompanionImage: 'lexora', welcomeCompanionImages: [] })
    const header = '47494638396101000100800000000000ffffff'
    const frame = '21f904000a0000002c0000000001000100000202440100'
    const animatedGif = `data:image/gif;base64,${Buffer.from(`${header}${frame}${frame}3b`, 'hex').toString('base64')}`
    for (const welcomeCompanionImage of ['whale', animatedGif, 'lexora']) {
      await store.update({ desktop: { chat: { welcomeCompanionImage } } })
      await store.update({ desktop: { language: 'en-US', chat: { welcomeGreetingEnabled: false } } })
      expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat)
        .toMatchObject({ welcomeCompanionImage, welcomeCompanionEnabled: false, welcomeGreetingEnabled: false })
      expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
        desktop: { chat: { welcome_companion_image: welcomeCompanionImage, future: true } },
      })
    }
  })

  it('migrates the selected custom image and deduplicates stored galleries without writing on read', async () => {
    for (const gallery of ['', `welcome_companion_images=["${welcomeGif}", "${welcomeGif}"]\n`]) {
      const content = `[desktop.chat]\nwelcome_companion_image="${welcomePng}"\n${gallery}future=true\n`
      const { store, configPath } = await createConfigStore(content)
      const images = gallery ? [welcomeGif, welcomePng] : [welcomePng]
      expect((await store.read()).desktop.chat).toMatchObject({ welcomeCompanionImage: welcomePng, welcomeCompanionImages: images })
      expect(await readFile(configPath, 'utf8')).toBe(content)
      await store.update({ desktop: { chat: { welcomeCompanionImage: 'lexora' } } })
      expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat)
        .toMatchObject({ welcomeCompanionImage: 'lexora', welcomeCompanionImages: images })
      expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
        desktop: { chat: { welcome_companion_image: 'lexora', welcome_companion_images: images, future: true } },
      })
    }
  })

  it('saves and deduplicates galleries independently while disabled and preserves them across selection and restart', async () => {
    const { store, configPath } = await createConfigStore('[desktop.chat]\nwelcome_companion_enabled=false\n')
    await store.update({ desktop: { chat: { welcomeCompanionImages: [welcomeGif, welcomeGif] } } })
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat)
      .toMatchObject({ welcomeCompanionEnabled: false, welcomeCompanionImage: 'lexora', welcomeCompanionImages: [welcomeGif] })
    await store.update({ desktop: { chat: { welcomeCompanionImage: welcomePng } } })
    expect((await store.read()).desktop.chat).toMatchObject({ welcomeCompanionImage: welcomePng, welcomeCompanionImages: [welcomeGif, welcomePng] })
    await store.update({ desktop: { chat: { welcomeCompanionImages: [welcomeGif, welcomeGif] } } })
    expect((await store.read()).desktop.chat).toMatchObject({ welcomeCompanionImage: welcomePng, welcomeCompanionImages: [welcomeGif, welcomePng] })
    for (const welcomeCompanionImage of ['whale', 'lexora']) {
      await store.update({ desktop: { chat: { welcomeCompanionImage } } })
      expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat)
        .toMatchObject({ welcomeCompanionEnabled: false, welcomeCompanionImage, welcomeCompanionImages: [welcomeGif, welcomePng] })
    }
    await store.update({ desktop: { chat: { welcomeCompanionImages: [welcomePng, welcomePng] } } })
    expect((await store.read()).desktop.chat).toMatchObject({ welcomeCompanionImage: 'lexora', welcomeCompanionImages: [welcomePng] })
    await store.update({ desktop: { chat: { welcomeCompanionImages: [] } } })
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat)
      .toMatchObject({ welcomeCompanionImage: 'lexora', welcomeCompanionImages: [] })
  })

  it('defaults legacy profiles and preserves independent preferences, ordered pins and unknown fields across partial writes and restart', async () => {
    const { configPath, store } = await createConfigStore('[api]\nbase_url="https://lexora.example"\n[desktop]\nnotify_when_focused=true\nsidebar_collapsed=true\nfuture_setting=true\n[desktop.chat]\nwelcome="none"\nfuture=true\n[desktop.typography]\nfuture=true\n[desktop.task_sidebar]\nfuture=true\n[browser]\nfuture=true\n')
    const defaults = {
      browser: DEFAULT_BROWSER_PREFERENCES,
      runtime: { codemode: true, modelRetryLimit: 3 },
      desktop: {
        localBackupLimit: 3,
        navigationLayout: 'full',
        featureAnnouncementsEnabled: true,
        featureDiscovery: { version: '', pending: [], notified: [] },
        notificationsEnabled: true,
        subtaskNotificationsEnabled: true,
        pluginAuthor: '',
        keybindings: {},
        typography: DEFAULT_TYPOGRAPHY,
        chat: { pasteTextAsAttachment: true, permissionMode: 'policy_approval' },
      },
    }
    expect(await store.read()).toMatchObject(defaults)
    const profile = { userName: 'Alice', deviceName: 'Alice-Laptop', avatar: 'data:image/png;base64,abc' }
    const preferences = {
      runtime: { cacheWarming: 'streaming' },
      browser: { linkOpening: 'system', screenshotDestination: 'clipboard', defaultZoomFactor: 1.25, freezeBackground: false, freezeForeground: true, freezeDelaySeconds: 120 },
      proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' },
      desktop: {
        localBackupLimit: 1,
        navigationLayout: 'immersive',
        subtaskNotificationsEnabled: false,
        updateNotificationsEnabled: false,
        featureAnnouncementsEnabled: false,
        featureDiscovery: { version: '0.13.0', pending: ['npc-team'], notified: ['navigation-layout', 'npc-team'] },
        chat: { welcome: 'writing', pasteTextAsAttachment: false, permissionMode: 'full_access' },
        typography: { bodyFont: 'Noto Serif CJK SC', bodySize: 15 },
        keybindings: { 'task.new': 'Mod+Alt+N', 'view.close': '' },
        pluginAuthor: '山雨海 · Équipe 🎨',
        profile,
        taskSidebar: { collapsed: false, collapsedSections: ['tasks', 'spaces'], collapsedSpaces: ['space-a'], width: 336 },
        taskSidebarPinnedItems: [{ id: 'space-a', kind: 'space' }, { id: 'conversation-a', kind: 'conversation' }],
        contextPanelMode: 'space',
        contextPanelGlobal: true,
        theme: { id: 'lexora.themes.classic-dark' },
      },
      pet: { alwaysOnTop: false, enabled: false, rememberPosition: false },
    } satisfies LexoraConfigPatch
    expect(await store.update(preferences)).toMatchObject(preferences)
    await store.update({
      proxy: { mode: 'direct', server: preferences.proxy.server },
      desktop: { localBackupLimit: 10, language: 'en-US', contextPanelGlobal: false, profile: { userName: 'Bob' }, taskSidebar: { collapsedSpaces: ['space-b'] }, typography: { codeFont: 'Consolas' } },
    })
    const reopened = new LexoraConfigStore({ configPath })
    expect(await reopened.read()).toMatchObject({
      ...preferences,
      proxy: { mode: 'direct', server: preferences.proxy.server },
      desktop: {
        ...preferences.desktop,
        localBackupLimit: 10,
        sidebarCollapsed: true,
        notificationsEnabled: true,
        notifyWhenFocused: true,
        language: 'en-US',
        contextPanelGlobal: false,
        profile: { ...profile, userName: 'Bob' },
        taskSidebar: { ...preferences.desktop.taskSidebar, collapsedSpaces: ['space-b'] },
        typography: { ...DEFAULT_TYPOGRAPHY, ...preferences.desktop.typography, codeFont: 'Consolas' },
      },
    })
    await store.update({ desktop: { typography: { ...DEFAULT_TYPOGRAPHY }, keybindings: {}, pluginAuthor: '' } })
    expect((await reopened.read()).desktop).toMatchObject({
      typography: DEFAULT_TYPOGRAPHY,
      keybindings: {},
      pluginAuthor: '',
      subtaskNotificationsEnabled: false,
      profile: { ...profile, userName: 'Bob' },
      chat: preferences.desktop.chat,
    })
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
      api: { base_url: 'https://lexora.example' },
      desktop: { future_setting: true, subtask_notifications_enabled: false, sidebar_collapsed: true, navigation_layout: 'immersive', task_sidebar: { future: true }, chat: { future: true, paste_text_as_attachment: false }, typography: { future: true } },
      browser: { future: true },
    })
    if (process.platform !== 'win32')
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('migrates paired and legacy themes without losing the selected appearance or custom themes', async () => {
    const cases = [
      ['[desktop]\ntheme="dark"\naccent_color="violet"\n', 'lexora.themes.violet-dark'],
      ...(['light', 'dark', 'system'] as const).map(mode => [
        `[desktop.theme]\nmode="${mode}"\nlight="author.ocean.day"\ndark="author.ocean.night"\n`,
        mode === 'system' ? 'system' : mode === 'dark' ? 'author.ocean.night' : 'author.ocean.day',
      ]),
    ]
    for (const [content, id] of cases) {
      const { configPath, store } = await createConfigStore(content)
      expect((await store.read()).desktop.theme).toEqual({ id })
      await store.update({ desktop: { language: 'en-US' } })
      expect((await new LexoraConfigStore({ configPath }).read()).desktop.theme).toEqual({ id })
    }
  })

  it('preserves disabled, finite and unlimited model retry limits across unrelated updates and restart', async () => {
    const { store, configPath } = await createConfigStore('[runtime]\ncache_warming="streaming"\nfuture=true\n')
    for (const modelRetryLimit of [0, 7, 'unlimited'] as const) {
      await store.update({ runtime: { modelRetryLimit } })
      await store.update({ desktop: { language: 'en-US' } })
      expect((await new LexoraConfigStore({ configPath }).read()).runtime).toEqual({ cacheWarming: 'streaming', codemode: true, modelRetryLimit })
    }
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({ runtime: { future: true, model_retry_limit: 'unlimited' } })
  })

  it('defaults codemode on without overwriting an explicit choice across partial updates and restart', async () => {
    for (const codemode of [undefined, false, true]) {
      const content = codemode === undefined ? '[runtime]\nfuture=true\n' : `[runtime]\ncodemode=${codemode}\nfuture=true\n`
      const { store, configPath } = await createConfigStore(content)
      expect((await store.read()).runtime.codemode).toBe(codemode ?? true)
      expect(await readFile(configPath, 'utf8')).toBe(content)
      await store.update({ desktop: { language: 'en-US' } })
      expect((await new LexoraConfigStore({ configPath }).read()).runtime.codemode).toBe(codemode ?? true)
      expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({ runtime: { codemode: codemode ?? true, future: true } })
    }
  })

  it('restores active and saved preferences after an apply failure or an expired write', async () => {
    for (const failure of ['apply', 'expired'] as const) {
      const { configPath, store } = await createConfigStore()
      const previous = await store.update({ desktop: { profile: { userName: 'Saved profile' } } })
      const saved = await readFile(configPath, 'utf8')
      let active = previous
      let expired = false
      await expect(store.update({ proxy: { mode: 'custom', server: 'http://127.0.0.1:7890' } }, (next) => {
        active = next
        if (next.proxy.mode === 'custom') {
          if (failure === 'apply')
            throw new Error('Isolated settings failure')
          expired = true
        }
      }, () => {
        if (expired)
          throw new Error('Isolated settings failure')
      })).rejects.toThrow('Isolated settings failure')
      expect(active).toEqual(previous)
      expect(await readFile(configPath, 'utf8')).toBe(saved)
      expect(await new LexoraConfigStore({ configPath }).read()).toEqual(previous)
    }
  })

  it('preserves welcome content and selection across concurrent partial writes and restart', async () => {
    const { configPath, store } = await createConfigStore()
    const first = { kind: 'custom' as const, id: 'custom-123', text: '新的一天，尽情创造' }
    const second = { kind: 'custom' as const, id: 'custom-456', text: '第二条自定义' }
    await store.update({ desktop: { chat: { welcome: first.id, welcomeItems: [first] } } })
    await Promise.all([
      store.update({ desktop: { chat: { welcomeItems: [first, second] } } }),
      store.update({ desktop: { chat: { welcome: second.id } } }),
    ])
    expect((await new LexoraConfigStore({ configPath }).read()).desktop.chat).toMatchObject({ welcome: second.id, welcomeItems: [first, second] })
  })

  it('migrates stored welcome text, preserves disabled preferences and does not restore deleted messages', async () => {
    const { configPath, store } = await createConfigStore(`
[desktop.chat]
welcome = "custom-kept"
[[desktop.chat.welcome_items]]
id = "writing"
text = "今天想一起完成什么？"
[[desktop.chat.welcome_items]]
id = "custom-kept"
text = "保留我的内容"
`)
    const loaded = await store.read()
    expect(loaded.desktop.chat.welcomeItems).toEqual([
      { kind: 'preset', id: 'writing' },
      { kind: 'custom', id: 'custom-kept', text: '保留我的内容' },
    ])
    await store.update({ desktop: { chat: { welcomeEnabled: false } } })
    const restarted = new LexoraConfigStore({ configPath })
    expect((await restarted.read()).desktop.chat).toMatchObject({ welcomeEnabled: false, welcome: 'custom-kept', welcomeItems: loaded.desktop.chat.welcomeItems })
    await restarted.update({ desktop: { chat: { welcome: 'writing' } } })
    const remaining = [{ kind: 'custom' as const, id: 'custom-kept', text: '保留我的内容' }]
    await restarted.update({ desktop: { chat: { welcomeItems: remaining } } })
    expect((await store.read()).desktop.chat).toMatchObject({ welcome: 'random', welcomeEnabled: false, welcomeItems: remaining })
    await store.update({ desktop: { chat: { welcomeItems: [] } } })
    expect((await restarted.read()).desktop.chat).toMatchObject({ welcome: 'none', welcomeEnabled: false, welcomeItems: [] })
    await store.update({ desktop: { chat: { welcomeEnabled: true } } })
    expect((await restarted.read()).desktop.chat).toMatchObject({ welcomeEnabled: true, welcome: 'none', welcomeItems: [] })
  })

  it('rejects invalid patches and malformed stored configuration without overwriting previous data', async () => {
    const { configPath, store } = await createConfigStore()
    const previous = await store.update({ desktop: { profile: { userName: 'Saved profile' }, chat: { welcomeCompanionImage: 'whale', welcomeCompanionImages: [welcomeGif] } } })
    const saved = await readFile(configPath, 'utf8')
    const invalidPatches = [
      { desktop: { chat: { welcomeCompanionImage: 'https://example.com/image.gif' } } },
      { desktop: { chat: { welcomeCompanionImage: 'lexora', welcomeCompanionImages: [welcomePng, 'whale'] } } },
      ...[0, 11, 1.5].map(localBackupLimit => ({ desktop: { localBackupLimit } })),
      { runtime: { modelRetryLimit: -1 } },
      { runtime: { cacheWarming: 'idle' } },
      { browser: { linkOpening: 'external' } },
      { browser: { defaultZoomFactor: 0 } },
      { browser: { freezeDelaySeconds: 1.5 } },
      { desktop: { chat: { permissionMode: 'invalid' } } },
      { desktop: { typography: { bodySize: 100 } } },
      { desktop: { navigationLayout: 'sidebar' } },
      { desktop: { keybindings: { 'task.new': 'not a shortcut' } } },
      { desktop: { pluginAuthor: '名'.repeat(81) } },
    ]
    for (const patch of invalidPatches) {
      await expect(store.update(patch as LexoraConfigPatch)).rejects.toThrow()
      expect(await readFile(configPath, 'utf8')).toBe(saved)
    }
    expect(await new LexoraConfigStore({ configPath }).read()).toEqual(previous)
    for (const content of [
      '[desktop\ntheme="dark"',
      '[desktop]\nsubtask_notifications_enabled="false"\n',
      '[desktop]\nnavigation_layout="sidebar"\n',
      '[desktop.chat]\npaste_text_as_attachment="false"\n',
      '[desktop.chat]\npermission_mode="invalid"\n',
      '[desktop.chat]\nwelcome_companion_image="https://example.com/image.gif"\n',
      '[desktop.chat]\nwelcome_companion_images=["lexora"]\n',
    ]) {
      await writeFile(configPath, content)
      await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
      await expect(store.update({ desktop: { language: 'en-US' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
      expect(await readFile(configPath, 'utf8')).toBe(content)
    }
  })
})
