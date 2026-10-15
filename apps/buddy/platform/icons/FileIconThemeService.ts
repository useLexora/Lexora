import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { FileIconThemeContribution, FileIconThemeSnapshot, ResolvedFileIconTheme } from '../../shared/icons/fileIconTheme'
import type { FileIconThemeRequest } from '../../shared/icons/fileIconThemeApi'
import type { ExtensionPackage } from '../extensions/ExtensionPackageStore'
import { randomUUID } from 'node:crypto'
import { safeDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../shared/events/Emitter'
import { BUILTIN_FILE_ICON_THEME, FILE_ICON_PROTOCOL } from '../../shared/icons/fileIconTheme'
import { verifiedExtensionAsset } from '../extensions/extensionFiles'
import { FILE_ICON_ASSET_LIMIT, fileIconAssetPaths, fileIconAssetType, readFileIconTheme } from './fileIconThemeAssets'

interface ThemeEntry { package: ExtensionPackage, root: string, contribution: FileIconThemeContribution }
interface ActiveTheme { entry: ThemeEntry, token: string, resolved: ResolvedFileIconTheme, paths: Map<string, string>, cache: Map<string, Promise<Uint8Array>> }
const builtin = { id: BUILTIN_FILE_ICON_THEME, label: 'Material Icons', extensionId: null, packageName: 'Lexora' }

export class FileIconThemeService {
  readonly #changes = new Emitter<FileIconThemeSnapshot>(() => console.error('FILE_ICON_THEME_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #save: (preference: { id: string }, guard: () => void) => Promise<void>
  readonly #record: ApplicationDiagnosticReporter
  #entries = new Map<string, ThemeEntry>()
  #preference = { id: BUILTIN_FILE_ICON_THEME }
  #active: ActiveTheme | null = null
  #revision = 0
  #generation = 0
  #disposed = false
  #loading: Promise<void> = Promise.resolve()

  constructor(save: (preference: { id: string }, guard: () => void) => Promise<void>, record?: ApplicationDiagnosticReporter) {
    this.#save = save
    this.#record = safeDiagnosticReporter(record)
  }

  get snapshot(): FileIconThemeSnapshot {
    return structuredClone({
      revision: this.#revision,
      preference: this.#preference,
      active: this.#active?.resolved ?? null,
      unavailable: this.#preference.id !== BUILTIN_FILE_ICON_THEME && !this.#active ? this.#preference.id : null,
      themes: [builtin, ...[...this.#entries.values()].map(entry => this.#descriptor(entry))],
    })
  }

  #descriptor(entry: ThemeEntry) {
    return { id: entry.contribution.id, label: entry.contribution.label, extensionId: entry.package.manifest.id, packageName: entry.package.manifest.name }
  }

  applyPreference(preference: { id: string }): void {
    if (preference.id === this.#preference.id || this.#disposed)
      return
    this.#preference = { ...preference }
    this.#loading = this.#activate()
  }

  async refresh(packages: Array<{ package: ExtensionPackage, root: string }>): Promise<void> {
    const entries = new Map<string, ThemeEntry>()
    for (const pkg of packages) {
      for (const contribution of pkg.package.manifest.contributes.iconThemes) {
        const previous = this.#entries.get(contribution.id)
        entries.set(contribution.id, previous?.package.revision === pkg.package.revision && previous.root === pkg.root ? previous : { ...pkg, contribution })
      }
    }
    this.#entries = entries
    this.#loading = this.#activate()
    await this.#loading
  }

  async #activate(): Promise<void> {
    const generation = ++this.#generation
    const entry = this.#entries.get(this.#preference.id)
    if (this.#active?.entry === entry && entry) {
      this.#publish()
      return
    }
    this.#active = null
    this.#publish()
    if (!entry || this.#disposed)
      return
    try {
      const bytes = await verifiedExtensionAsset(entry.root, entry.contribution.path, entry.package.hashes[entry.contribution.path]!)
      const document = readFileIconTheme(bytes)
      const paths = fileIconAssetPaths(entry.contribution.path, document)
      for (const path of paths.values()) {
        if (!Object.hasOwn(entry.package.hashes, path))
          throw new Error('EXTENSION_ICON_THEME_ASSET_INVALID')
      }
      if (generation !== this.#generation || this.#disposed)
        return
      const token = randomUUID()
      const urls = Object.fromEntries([...paths.keys()].map(id => [id, `${FILE_ICON_PROTOCOL}://theme/${token}/${encodeURIComponent(id)}`]))
      this.#active = { entry, token, paths, cache: new Map(), resolved: { document, urls, descriptor: this.#descriptor(entry) } }
      this.#publish()
    }
    catch {
      if (generation === this.#generation && !this.#disposed)
        this.#record({ component: 'desktop.icons', level: 'warn', event: 'icons.theme.invalid', extensionId: entry.package.manifest.id, errorCode: 'EXTENSION_ICON_THEME_UNAVAILABLE' })
    }
  }

  async request(input: FileIconThemeRequest, guard: () => void): Promise<FileIconThemeSnapshot> {
    guard()
    if (input.action === 'preference') {
      const assertAvailable = () => {
        guard()
        if (this.#disposed || (input.preference.id !== BUILTIN_FILE_ICON_THEME && !this.#entries.has(input.preference.id)))
          throw new Error('EXTENSION_ICON_THEME_UNAVAILABLE')
      }
      assertAvailable()
      await this.#save(input.preference, assertAvailable)
      this.applyPreference(input.preference)
    }
    await this.#loading
    guard()
    return this.snapshot
  }

  async asset(url: string): Promise<{ bytes: Uint8Array, type: string } | null> {
    const active = this.#active
    if (!active || this.#disposed)
      return null
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/')
    if (parsed.protocol !== `${FILE_ICON_PROTOCOL}:` || parsed.hostname !== 'theme' || parsed.search || parsed.hash || parts.length !== 3 || parts[1] !== active.token)
      return null
    const path = active.paths.get(decodeURIComponent(parts[2]!))
    if (!path)
      return null
    try {
      let pending = active.cache.get(path)
      if (!pending) {
        pending = verifiedExtensionAsset(active.entry.root, path, active.entry.package.hashes[path]!).then((bytes) => {
          if (!bytes.length || bytes.length > FILE_ICON_ASSET_LIMIT)
            throw new Error('EXTENSION_ICON_THEME_ASSET_INVALID')
          return bytes
        })
        active.cache.set(path, pending)
      }
      const bytes = await pending
      return this.#active === active && !this.#disposed ? { bytes, type: fileIconAssetType(path) } : null
    }
    catch {
      if (this.#active === active) {
        this.#active = null
        this.#publish()
        this.#record({ component: 'desktop.icons', level: 'warn', event: 'icons.asset.invalid', extensionId: active.entry.package.manifest.id, errorCode: 'EXTENSION_ICON_THEME_ASSET_INVALID' })
      }
      return null
    }
  }

  #publish(): void {
    if (!this.#disposed) {
      this.#revision++
      this.#changes.fire(this.snapshot)
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#generation++
    this.#active = null
    this.#entries.clear()
    this.#changes.dispose()
  }
}
