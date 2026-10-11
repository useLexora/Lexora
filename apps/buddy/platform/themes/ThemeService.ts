import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { EventSnapshot } from '../../shared/events/eventTypes'
import type { ResolvedTheme } from '../../shared/theme/resolveTheme'
import type { ThemeArchive, ThemePreview, ThemeRequest, ThemeSnapshot } from '../../shared/theme/themeApi'
import type { ThemeDescriptor, ThemeDocument } from '../../shared/theme/themeDocument'
import type { ThemePreference } from '../../shared/theme/themePreferences'
import type { ExtensionPackage } from '../extensions/ExtensionPackageStore'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { safeDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../shared/events/Emitter'
import { copyEventSnapshot } from '../../shared/events/eventSnapshot'
import { fallbackTheme, resolveTheme } from '../../shared/theme/resolveTheme'
import { themeArchiveSchema, themeRequestSchema } from '../../shared/theme/themeApi'
import { describeTheme, themeAssetPaths, themeDocumentSchema } from '../../shared/theme/themeDocument'
import { DEFAULT_THEME_PREFERENCE, themeIdSchema, themePreferenceSchema } from '../../shared/theme/themePreferences'
import { readExtensionJson, verifiedExtensionAsset, writeExtensionJson } from '../extensions/extensionFiles'
import { themeAssetUrl, validateThemeArchive } from './themeAssets'

interface ThemeEntry { descriptor: ThemeDescriptor, document: ThemeDocument, resolved: ResolvedTheme, archive: ThemeArchive }
interface Preview extends ThemePreview { owner: string, entry: ThemeEntry }
const userThemesSchema = z.object({ version: z.literal(1), themes: z.record(themeIdSchema, themeArchiveSchema) }).strict()
type UserThemes = z.infer<typeof userThemesSchema>
interface UserThemeSave { entry: ThemeEntry, users: UserThemes, entries: Map<string, ThemeEntry> }
export interface ThemePackage { package: ExtensionPackage, root: string }

export class ThemeService {
  readonly #path: string
  readonly #savePreference: (preference: ThemePreference, assertCurrent: () => void) => Promise<void>
  readonly #readSystemDark?: () => boolean
  readonly #record: ApplicationDiagnosticReporter
  readonly #fallbacks = { light: fallbackTheme('light'), dark: fallbackTheme('dark') }
  readonly #changes = new Emitter<EventSnapshot<ThemeSnapshot>>(() => console.error('THEME_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #plugins = new Map<string, ThemeEntry>()
  #users: UserThemes = { version: 1, themes: {} }
  #userEntries = new Map<string, ThemeEntry>()
  #storeReadable = true
  #pendingSave: UserThemeSave | null = null
  #snapshot: ThemeSnapshot | null = null
  #preference = DEFAULT_THEME_PREFERENCE
  #fallbackDark = false
  #systemDark = false
  #readingSystem = false
  #revision = 0
  #catalogGeneration = 0
  #preview: Preview | null = null
  #tail = Promise.resolve()
  #disposed = false

  constructor(home: string, savePreference: (preference: ThemePreference, assertCurrent: () => void) => Promise<void>, options: { readSystemDark?: () => boolean, record?: ApplicationDiagnosticReporter } = {}) {
    this.#path = join(home, 'themes', 'user-themes.json')
    this.#savePreference = savePreference
    this.#readSystemDark = options.readSystemDark
    this.#record = safeDiagnosticReporter(options.record)
  }

  async initialize(preference: ThemePreference, dark: boolean): Promise<void> {
    try {
      const stored = userThemesSchema.parse(await readExtensionJson(this.#path, 32 * 1024 * 1024))
      const entries = new Map<string, ThemeEntry>()
      for (const [id, archive] of Object.entries(stored.themes)) {
        if (!id.startsWith('user.theme.'))
          throw new Error('EXTENSION_THEME_ID_INVALID')
        entries.set(id, this.#userEntry(id, archive))
      }
      this.#users = stored
      this.#userEntries = entries
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#storeReadable = false
        this.#record({ component: 'desktop.themes', level: 'warn', event: 'themes.store.unreadable', errorCode: 'EXTENSION_THEME_STORE_UNREADABLE' })
      }
    }
    this.#preference = themePreferenceSchema.parse(preference)
    this.#systemDark = dark
    this.#fallbackDark = (this.#entry(preference.id)?.descriptor.appearance ?? (dark ? 'dark' : 'light')) === 'dark'
    this.#snapshot = null
  }

  get snapshot(): ThemeSnapshot {
    return structuredClone(this.#snapshot ??= this.#buildSnapshot())
  }

  #buildSnapshot(): ThemeSnapshot {
    const system = this.#preference.id === 'system'
    const requested = system ? `lexora.themes.classic-${this.#systemDark ? 'dark' : 'light'}` : this.#preference.id
    const entry = this.#entry(requested)
    const preview = this.#preview
    const active = preview?.entry.resolved ?? entry?.resolved ?? this.#fallbacks[(system ? this.#systemDark : this.#fallbackDark) ? 'dark' : 'light']
    return {
      revision: this.#revision,
      preference: this.#preference,
      active,
      themes: [...this.#plugins.values(), ...this.#userEntries.values()].map(item => item.descriptor),
      unavailable: !system && !preview && active.descriptor.id !== requested ? requested : null,
      preview: !!preview,
    }
  }

  applyPreference(preference: ThemePreference): void {
    const next = themePreferenceSchema.parse(preference)
    const saved = this.#pendingSave?.entry.descriptor.id === next.id
    if (saved) {
      this.#acceptSave(this.#pendingSave!)
      this.#pendingSave = null
    }
    if (!saved && next.id === this.#preference.id)
      return
    this.#preference = next
    this.#preview = null
    this.#publish()
  }

  setSystemDark(dark: boolean): void {
    if (dark === this.#systemDark)
      return
    this.#systemDark = dark
    if (this.#preference.id === 'system' && !this.#preview && !this.#readingSystem)
      this.#publish()
  }

  async refresh(packages: ThemePackage[]): Promise<void> {
    const generation = ++this.#catalogGeneration
    const entries = new Map<string, ThemeEntry>()
    for (const { package: pkg, root } of packages) {
      for (const contribution of pkg.manifest.contributes.themes) {
        try {
          const bytes = await verifiedExtensionAsset(root, contribution.path, pkg.hashes[contribution.path]!)
          const document = themeDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
          const assets: Record<string, string> = {}
          const encoded: Record<string, string> = {}
          for (const path of themeAssetPaths(document)) {
            const bytes = await verifiedExtensionAsset(root, path, pkg.hashes[path]!)
            assets[path] = themeAssetUrl(path, bytes)
            encoded[path] = Buffer.from(bytes).toString('base64')
          }
          const descriptor: ThemeDescriptor = { id: contribution.id, label: contribution.label, appearance: contribution.appearance, source: 'plugin', extensionId: pkg.manifest.id, packageName: pkg.manifest.name, swatch: document.colors.accent ?? this.#fallbacks[contribution.appearance].colors.accent }
          entries.set(contribution.id, { descriptor, document, resolved: resolveTheme(descriptor, document, {}, assets), archive: { schemaVersion: 1, label: contribution.label, appearance: contribution.appearance, document, assets: encoded } })
        }
        catch {
          this.#record({ component: 'desktop.themes', level: 'warn', event: 'themes.package.invalid', extensionId: pkg.manifest.id, errorCode: 'EXTENSION_THEME_UNAVAILABLE' })
        }
      }
    }
    if (generation !== this.#catalogGeneration || this.#disposed)
      return
    this.#plugins = entries
    this.#publish()
  }

  request(owner: string, raw: ThemeRequest, assertCurrent: () => void = () => {}): Promise<unknown> {
    const input = themeRequestSchema.parse(raw)
    const operation = this.#tail.then(async () => {
      if (this.#disposed)
        throw new Error('EXTENSION_THEME_STOPPED')
      assertCurrent()
      switch (input.action) {
        case 'active': return this.snapshot
        case 'list': return structuredClone((this.#snapshot ??= this.#buildSnapshot()).themes)
        case 'get': {
          const entry = this.#require(input.id)
          return structuredClone({ descriptor: entry.descriptor, document: entry.document })
        }
        case 'describe': return describeTheme()
        case 'validate': {
          const result = themeDocumentSchema.safeParse(input.document)
          return { valid: result.success, diagnostics: result.success ? [] : result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }
        }
        case 'resolve': return resolveTheme(this.#descriptor('user.preview', { label: 'Preview', appearance: input.appearance }), input.document, input.overrides)
        case 'export': return JSON.stringify(this.#require(input.id).archive, null, 2)
        case 'import': return this.#save(undefined, JSON.parse(input.content), assertCurrent)
        case 'save': return this.#save(input.id, input.archive, assertCurrent)
        case 'remove': {
          if (!Object.hasOwn(this.#users.themes, input.id))
            throw new Error('EXTENSION_THEME_READONLY')
          const next = structuredClone(this.#users)
          delete next.themes[input.id]
          await this.#write(next, assertCurrent)
          this.#users = next
          this.#userEntries.delete(input.id)
          this.#publish()
          return null
        }
        case 'preference': {
          await this.#savePreference(input.preference, assertCurrent)
          this.applyPreference(input.preference)
          if (this.#preview) {
            this.#preview = null
            this.#publish()
          }
          return this.snapshot
        }
        case 'beginPreview': {
          const entry = this.#userEntry('user.preview', input.archive)
          this.#preview = { token: randomUUID(), revision: 0, owner, entry }
          this.#publish()
          return { token: this.#preview.token, revision: 0 }
        }
        case 'updatePreview': {
          const preview = this.#ownedPreview(owner, input.token, input.revision)
          const entry = this.#userEntry('user.preview', input.archive)
          this.#preview = { ...preview, revision: preview.revision + 1, entry }
          this.#publish()
          return { token: preview.token, revision: preview.revision + 1 }
        }
        case 'cancelPreview': {
          if (this.#preview?.owner === owner && this.#preview.token === input.token) {
            this.#preview = null
            this.#publish()
          }
          return null
        }
        case 'commitPreview': {
          const preview = this.#ownedPreview(owner, input.token, input.revision)
          const guard = () => {
            assertCurrent()
            this.#ownedPreview(owner, input.token, input.revision)
          }
          const saved = await this.#storeUser(undefined, preview.entry.archive, guard)
          this.#pendingSave = saved
          try {
            guard()
            const preference = { id: saved.entry.descriptor.id }
            await this.#savePreference(preference, guard)
            this.applyPreference(preference)
            return structuredClone(saved.entry.descriptor)
          }
          finally {
            if (this.#pendingSave) {
              this.#acceptSave(this.#pendingSave)
              this.#pendingSave = null
              this.#publish()
            }
          }
        }
      }
    })
    this.#tail = operation.then(() => {}, () => {})
    return operation
  }

  releaseOwner(owner: string): void {
    if (this.#preview?.owner === owner || this.#preview?.owner.startsWith(`${owner}:`)) {
      this.#preview = null
      this.#publish()
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    ++this.#catalogGeneration
    this.#preview = null
    await this.#tail
    this.#changes.dispose()
  }

  #ownedPreview(owner: string, token: string, revision: number): Preview {
    const preview = this.#preview
    if (!preview || preview.owner !== owner || preview.token !== token || preview.revision !== revision)
      throw new Error('EXTENSION_THEME_PREVIEW_EXPIRED')
    return preview
  }

  #entry(id: string): ThemeEntry | undefined {
    return this.#userEntries.get(id) ?? this.#plugins.get(id)
  }

  #require(id: string): ThemeEntry {
    const entry = this.#entry(id)
    if (!entry)
      throw new Error('EXTENSION_THEME_UNAVAILABLE')
    return entry
  }

  #descriptor(id: string, archive: Pick<ThemeArchive, 'label' | 'appearance'> & { document?: ThemeDocument }): ThemeDescriptor {
    return { id, label: archive.label, appearance: archive.appearance, source: 'user', extensionId: null, packageName: '', swatch: archive.document?.colors.accent ?? this.#fallbacks[archive.appearance].colors.accent }
  }

  #userEntry(id: string, input: unknown): ThemeEntry {
    const { archive, assets } = validateThemeArchive(input)
    const descriptor = this.#descriptor(id, archive)
    return { descriptor, document: archive.document, archive, resolved: resolveTheme(descriptor, archive.document, {}, assets) }
  }

  async #save(id: string | undefined, input: unknown, assertCurrent: () => void): Promise<ThemeDescriptor> {
    const saved = await this.#storeUser(id, input, assertCurrent)
    this.#acceptSave(saved)
    this.#publish()
    return structuredClone(saved.entry.descriptor)
  }

  async #storeUser(id: string | undefined, input: unknown, assertCurrent: () => void): Promise<UserThemeSave> {
    if (id && !Object.hasOwn(this.#users.themes, id))
      throw new Error('EXTENSION_THEME_READONLY')
    const key = id ?? `user.theme.${randomUUID()}`
    const entry = this.#userEntry(key, input)
    const next = { version: 1 as const, themes: { ...this.#users.themes, [key]: entry.archive } }
    if (Object.keys(next.themes).length > 128 || Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('EXTENSION_THEME_STORE_LIMIT')
    await this.#write(next, assertCurrent)
    return { entry, users: next, entries: new Map(this.#userEntries).set(key, entry) }
  }

  #acceptSave(saved: UserThemeSave): void {
    this.#users = saved.users
    this.#userEntries = saved.entries
  }

  async #write(next: UserThemes, assertCurrent: () => void): Promise<void> {
    if (!this.#storeReadable)
      throw new Error('EXTENSION_THEME_STORE_UNREADABLE')
    await writeExtensionJson(this.#path, next, () => {
      if (this.#disposed)
        throw new Error('EXTENSION_THEME_STOPPED')
      assertCurrent()
    })
  }

  #publish(): void {
    if (this.#disposed)
      return
    if (this.#preference.id === 'system' && !this.#preview && this.#readSystemDark) {
      this.#readingSystem = true
      try {
        this.#systemDark = this.#readSystemDark()
      }
      finally {
        this.#readingSystem = false
      }
    }
    const entry = this.#entry(this.#preference.id)
    if (entry)
      this.#fallbackDark = entry.descriptor.appearance === 'dark'
    ++this.#revision
    this.#snapshot = this.#buildSnapshot()
    this.#changes.fire(copyEventSnapshot(this.#snapshot))
  }
}
