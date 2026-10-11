import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ThemeArchiveInput, ThemePreview, ThemeSnapshot } from '../../../shared/theme/themeApi'
import type { ThemeDescriptor } from '../../../shared/theme/themeDocument'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { LexoraConfigStore } from '../../../electron/main/config/LexoraConfigStore'
import { fallbackTheme, resolveTheme } from '../../../shared/theme/resolveTheme'
import { DEFAULT_THEME_PREFERENCE } from '../../../shared/theme/themePreferences'
import { ExtensionPackageStore } from '../../extensions/ExtensionPackageStore'
import { bundledThemeFiles, seedBundledThemes } from '../bundledThemes'
import { validateThemeArchive } from '../themeAssets'
import { ThemeService } from '../ThemeService'

const archive: ThemeArchiveInput = { schemaVersion: 1, label: 'Ocean', appearance: 'light', document: { schemaVersion: 1, colors: { accent: '#207cba' } } }

async function fixture() {
  const home = await createTemporaryDirectory('lexora-themes-')
  let preference = { ...DEFAULT_THEME_PREFERENCE }
  const service = new ThemeService(home, async (next, guard) => {
    guard()
    preference = next as typeof preference
  })
  await service.initialize(preference, false)
  return { home, service, preference: () => preference }
}

describe('theme data and lifecycle', () => {
  it('migrates the legacy bundled package without enabling disabled themes', async () => {
    const home = await createTemporaryDirectory('lexora-bundled-upgrade-')
    const store = new ExtensionPackageStore(join(home, 'extensions'), '0.10.1')
    const files = bundledThemeFiles()
    const current = JSON.parse(Buffer.from(files.get('extension.json')!).toString('utf8'))
    const manifest = { ...current }
    manifest.name = 'Lexora 官方主题'
    manifest.version = '1.0.0'
    delete manifest.icon
    files.delete('icon.svg')
    files.set('extension.json', Buffer.from(JSON.stringify(manifest)))
    await store.install((await store.reviewFiles(files)).token)
    await writeFile(join(store.root, 'bundled-themes.json'), JSON.stringify({ version: 1 }))
    await store.enable('lexora.themes', false)
    await seedBundledThemes(store)
    expect(store.installed['lexora.themes']).toMatchObject({ enabled: false, pending: null, current: { manifest: { version: current.version } } })
  })

  it('publishes one complete snapshot for each committed selection and preview', async () => {
    const home = await createTemporaryDirectory('lexora-theme-commits-')
    const config = new LexoraConfigStore({ configPath: join(home, 'config.toml') })
    const service = new ThemeService(home, async (preference, guard) => {
      await config.update({ desktop: { theme: preference } }, undefined, guard)
    })
    config.onDidChange((change) => {
      if (change.kind === 'committed')
        service.applyPreference(change.config.desktop.theme)
    })
    await service.initialize((await config.read()).desktop.theme, false)
    const changes: EventSnapshot<ThemeSnapshot>[] = []
    service.onDidChange(snapshot => changes.push(snapshot))
    const saved = await service.request('desktop', { action: 'save', archive }) as ThemeDescriptor
    changes.length = 0
    await service.request('desktop', { action: 'preference', preference: { id: saved.id } })
    expect(changes).toHaveLength(1)
    expect(changes[0]!.active.descriptor.id).toBe(saved.id)
    changes.length = 0
    await service.request('desktop', { action: 'preference', preference: { id: saved.id } })
    expect(changes).toHaveLength(0)
    const lease = await service.request('desktop', { action: 'beginPreview', archive: { ...archive, appearance: 'dark' } }) as ThemePreview
    changes.length = 0
    const before = service.snapshot.revision
    const committed = await service.request('desktop', { action: 'commitPreview', ...lease }) as ThemeDescriptor
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ revision: before + 1, preview: false, preference: { id: committed.id }, active: { descriptor: { id: committed.id, appearance: 'dark' } } })
    expect(changes[0]!.themes.map(theme => theme.id)).toContain(committed.id)
    expect((await config.read()).desktop.theme.id).toBe(committed.id)
    await service.request('desktop', { action: 'beginPreview', archive })
    changes.length = 0
    await service.request('desktop', { action: 'preference', preference: { id: committed.id } })
    expect(changes).toHaveLength(1)
    expect(changes[0]!.preview).toBe(false)
    await service.dispose()
    await config.dispose()
  })

  it('keeps the previous selection and a recoverable user copy when a preview preference cannot be committed', async () => {
    const home = await createTemporaryDirectory('lexora-theme-failed-commit-')
    const service = new ThemeService(home, async (_preference, guard) => {
      guard()
      throw new Error('CONFIG_COMMIT_FAILED')
    })
    await service.initialize(DEFAULT_THEME_PREFERENCE, false)
    const lease = await service.request('desktop', { action: 'beginPreview', archive }) as ThemePreview
    const before = service.snapshot.revision
    await expect(service.request('desktop', { action: 'commitPreview', ...lease })).rejects.toThrow('CONFIG_COMMIT_FAILED')
    expect(service.snapshot).toMatchObject({ revision: before + 1, preference: DEFAULT_THEME_PREFERENCE, preview: true })
    const [saved] = service.snapshot.themes
    expect(saved!.label).toBe('Ocean')
    await service.dispose()
    const restored = new ThemeService(home, async () => {})
    await restored.initialize(DEFAULT_THEME_PREFERENCE, false)
    expect(restored.snapshot).toMatchObject({ preference: DEFAULT_THEME_PREFERENCE, preview: false })
    expect(restored.snapshot.themes[0]!.id).toBe(saved!.id)
    await restored.dispose()
  })

  it('rejects an expired owner during preference persistence without changing the saved selection', async () => {
    const home = await createTemporaryDirectory('lexora-theme-expired-commit-')
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let preference = DEFAULT_THEME_PREFERENCE
    const service = new ThemeService(home, async (next, guard) => {
      entered.resolve()
      await resume.promise
      guard()
      preference = next
    })
    await service.initialize(preference, false)
    const lease = await service.request('desktop:frame', { action: 'beginPreview', archive }) as ThemePreview
    const commit = service.request('desktop:frame', { action: 'commitPreview', ...lease })
    await entered.promise
    expect(service.snapshot.themes).toHaveLength(0)
    service.releaseOwner('desktop')
    resume.resolve()
    await expect(commit).rejects.toThrow('EXPIRED')
    expect(preference).toEqual(DEFAULT_THEME_PREFERENCE)
    expect(service.snapshot.preview).toBe(false)
    expect(service.snapshot.themes).toHaveLength(1)
    await service.dispose()
  })

  it('rechecks system appearance when returning from a fixed theme or preview without needing an update event', async () => {
    const home = await createTemporaryDirectory('lexora-theme-system-')
    let systemDark = true
    const service = new ThemeService(home, async () => {}, {
      readSystemDark: () => {
        service.setSystemDark(systemDark)
        return systemDark
      },
    })
    await service.initialize(DEFAULT_THEME_PREFERENCE, true)
    await service.request('desktop', { action: 'preference', preference: { id: 'lexora.themes.classic-light' } })
    systemDark = false
    const before = service.snapshot.revision
    await service.request('desktop', { action: 'preference', preference: DEFAULT_THEME_PREFERENCE })
    expect(service.snapshot.revision).toBe(before + 1)
    expect(service.snapshot.active.descriptor.appearance).toBe('light')
    const lease = await service.request('desktop', { action: 'beginPreview', archive }) as ThemePreview
    systemDark = true
    await service.request('desktop', { action: 'cancelPreview', token: lease.token })
    expect(service.snapshot.active.descriptor.appearance).toBe('dark')
    await service.dispose()
  })

  it('isolates theme documents, assets and descriptors from consumer mutations and updates them after a save', async () => {
    const { service } = await fixture()
    const encoded = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const material = { ...archive, document: { ...archive.document, welcome: { image: 'welcome.svg' } }, assets: { 'welcome.svg': encoded } }
    const saved = await service.request('desktop', { action: 'save', archive: material }) as ThemeDescriptor
    await service.request('desktop', { action: 'preference', preference: { id: saved.id } })
    const first = service.snapshot
    first.active.colors.accent = '#000000'
    first.active.document.colors.accent = '#ffffff'
    first.active.assets['welcome.svg'] = 'invalid'
    first.themes[0]!.label = 'Mutated'
    saved.label = 'Mutated response'
    const current = service.snapshot
    expect(current.active.colors.accent).toBe('#207cba')
    expect(current.active.document.colors.accent).toBe('#207cba')
    expect(current.active.assets['welcome.svg']).toBe(`data:image/svg+xml;base64,${encoded}`)
    expect(current.themes[0]!.label).toBe('Ocean')
    await service.request('desktop', { action: 'save', id: saved.id, archive: { ...archive, label: 'Changed', document: { schemaVersion: 1, colors: { accent: '#96304d' } } } })
    expect(service.snapshot.active.colors.accent).toBe('#96304d')
    expect(service.snapshot.active.assets).toEqual({})
    expect(service.snapshot.active.descriptor.label).toBe('Changed')
    await service.dispose()
  })

  it.each(['{"version":1,"themes":', '{"version":1,"themes":{"user.theme.invalid":{}}}'])('starts with a fallback and preserves an unreadable theme store: %s', async (content) => {
    const home = await createTemporaryDirectory('lexora-theme-unreadable-')
    const path = join(home, 'themes', 'user-themes.json')
    await mkdir(join(home, 'themes'))
    await writeFile(path, content)
    const codes: string[] = []
    const service = new ThemeService(home, async () => {}, { record: event => codes.push(event.errorCode!) })
    await service.initialize({ id: 'user.theme.selected' }, true)
    expect(service.snapshot).toMatchObject({ preference: { id: 'user.theme.selected' }, unavailable: 'user.theme.selected', active: { descriptor: { appearance: 'dark' } } })
    expect(codes).toContain('EXTENSION_THEME_STORE_UNREADABLE')
    await expect(service.request('desktop', { action: 'save', archive })).rejects.toThrow('EXTENSION_THEME_STORE_UNREADABLE')
    expect(await readFile(path, 'utf8')).toBe(content)
    await service.request('desktop', { action: 'preference', preference: DEFAULT_THEME_PREFERENCE })
    expect(service.snapshot.unavailable).toBeNull()
    await service.dispose()
  })

  it('derives states after merging overrides, preserves explicit states, and rejects executable theme values', () => {
    const descriptor = fallbackTheme('light').descriptor
    const theme = resolveTheme(descriptor, archive.document)
    const changed = resolveTheme(descriptor, archive.document, { accent: '#96304d', hover: '#12345678', reading: '#fafafa' })
    expect(changed.colors.hover).toBe('#12345678')
    expect(changed.colors['nav-hover']).toBe('#12345678')
    expect(changed.colors.selected).not.toBe(theme.colors.selected)
    expect(changed.colors['accent-hover']).not.toBe(theme.colors['accent-hover'])
    expect(changed.colors.reading).toBe('#fafafa')
    expect(changed.colors.canvas).toBe(theme.colors.canvas)
    expect(changed.descriptor).toMatchObject({ swatch: '#96304d', preview: { accent: '#96304d', canvas: changed.colors.canvas, surface: changed.colors.surface, fg: changed.colors.fg } })
    expect(() => validateThemeArchive({ ...archive, document: { schemaVersion: 1, colors: { accent: 'url(https://example.test/a)' } } })).toThrow()
    expect(() => validateThemeArchive({ ...archive, document: { schemaVersion: 1, welcome: { image: '../outside.png' } } })).toThrow()
    expect(() => validateThemeArchive({ ...archive, document: { schemaVersion: 1, welcome: { image: 'missing.png' } } })).toThrow('EXTENSION_THEME_ASSET_MISSING')
  })

  it('loads bundled packages, preserves missing selections, restores enabled themes and honors uninstall across restart', async () => {
    const { home, service } = await fixture()
    const store = new ExtensionPackageStore(join(home, 'extensions'), '0.10.1')
    await store.load()
    await seedBundledThemes(store)
    const pkg = store.installed['lexora.themes']!.current
    const packages = [{ package: pkg, root: store.packageRoot(pkg) }]
    await service.refresh(packages)
    expect(service.snapshot.active.descriptor.id).toBe('lexora.themes.classic-light')
    service.setSystemDark(true)
    expect(service.snapshot.active.descriptor.id).toBe('lexora.themes.classic-dark')
    await service.request('desktop', { action: 'preference', preference: { id: 'lexora.themes.violet-dark' } })
    service.setSystemDark(false)
    expect(service.snapshot.active.descriptor.id).toBe('lexora.themes.violet-dark')
    await service.refresh([])
    expect(service.snapshot.unavailable).toBe('lexora.themes.violet-dark')
    expect(service.snapshot.preference.id).toBe('lexora.themes.violet-dark')
    expect(service.snapshot.active.descriptor.appearance).toBe('dark')
    await service.refresh(packages)
    expect(service.snapshot.unavailable).toBeNull()
    await writeFile(join(packages[0]!.root, 'themes/violet-dark.json'), JSON.stringify(archive.document))
    await service.refresh(packages)
    expect(service.snapshot.unavailable).toBe('lexora.themes.violet-dark')
    await service.request('desktop', { action: 'preference', preference: DEFAULT_THEME_PREFERENCE })
    expect(service.snapshot.active.descriptor.id).toBe('lexora.themes.classic-light')
    await service.refresh([])
    service.setSystemDark(true)
    expect(service.snapshot.active.descriptor.appearance).toBe('dark')
    expect(service.snapshot.unavailable).toBeNull()
    await store.uninstall('lexora.themes')
    const reopened = new ExtensionPackageStore(store.root, '0.10.1')
    await reopened.load()
    await seedBundledThemes(reopened)
    expect(reopened.installed['lexora.themes']).toBeUndefined()
    await service.dispose()
  })

  it('owns previews by lease and revision, never persists cancellation, and commits a standalone user copy', async () => {
    const { home, service, preference } = await fixture()
    const first = await service.request('editor:1', { action: 'beginPreview', archive }) as ThemePreview
    const second = await service.request('editor:2:view', { action: 'beginPreview', archive }) as ThemePreview
    await service.request('editor:1', { action: 'cancelPreview', token: first.token })
    expect(service.snapshot.preview).toBe(true)
    await expect(service.request('editor:1', { action: 'commitPreview', ...first })).rejects.toThrow('EXPIRED')
    const changed = await service.request('editor:2:view', { action: 'updatePreview', ...second, archive: { ...archive, label: 'Changed' } }) as ThemePreview
    await expect(service.request('editor:2:view', { action: 'commitPreview', ...second })).rejects.toThrow('EXPIRED')
    service.releaseOwner('editor:2')
    expect(service.snapshot.preview).toBe(false)
    expect(preference().id).toBe(DEFAULT_THEME_PREFERENCE.id)
    await expect(service.request('editor:2:view', { action: 'updatePreview', ...changed, archive })).rejects.toThrow('EXPIRED')
    const lease = await service.request('editor:3', { action: 'beginPreview', archive: { ...archive, appearance: 'dark' } }) as ThemePreview
    const saved = await service.request('editor:3', { action: 'commitPreview', ...lease }) as ThemeDescriptor
    expect(saved.source).toBe('user')
    expect(preference().id).toBe(saved.id)
    expect(service.snapshot.active.descriptor.appearance).toBe('dark')
    await service.request('editor:3', { action: 'beginPreview', archive: { ...archive, label: 'Unsaved' } })
    await service.dispose()
    const restored = new ThemeService(home, async () => {})
    await restored.initialize(preference(), false)
    expect(restored.snapshot.preview).toBe(false)
    expect(restored.snapshot.active.descriptor.id).toBe(saved.id)
    expect(restored.snapshot.active.descriptor.label).toBe('Ocean')
    await expect(restored.request('editor', { action: 'save', id: 'lexora.themes.classic-light', archive })).rejects.toThrow('READONLY')
    const exported = await restored.request('editor', { action: 'export', id: saved.id }) as string
    const imported = await restored.request('editor', { action: 'import', content: exported }) as ThemeDescriptor
    expect(imported.id).not.toBe(saved.id)
    expect(imported.swatch).toBe(saved.swatch)
    await restored.request('editor', { action: 'remove', id: saved.id })
    expect(restored.snapshot.unavailable).toBe(saved.id)
    await restored.dispose()
  })
})
