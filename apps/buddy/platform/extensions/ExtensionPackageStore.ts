import type { ExtensionManifest } from '../../shared/extensions/extensionManifest'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionCompiler } from './compileExtensionSource'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gt, satisfies } from 'semver'
import { z } from 'zod'
import { extensionResourceSchema } from '../../shared/extensions/extensionApi'
import { addedExtensionPermissions, extensionCompatible, extensionIdSchema, extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { spaceFileTargetSchema } from '../../shared/spaces/spaceFileApi'
import { EXTENSION_PACKAGE_LIMIT, readExtensionDirectory, readExtensionFile, readExtensionJson, sha256, unpackExtension, validateExtensionFiles, verifiedExtensionAsset, writeExtensionJson } from './extensionFiles'
import { extensionIconUrl } from './extensionIcon'
import { ExtensionResourceStore } from './ExtensionResourceStore'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z.object({ catalog: z.string().url(), artifact: z.string().url(), sha256: revisionSchema }).strict()
const packageSchema = z.object({ manifest: extensionManifestSchema, revision: revisionSchema, hashes: z.record(z.string(), revisionSchema), source: sourceSchema.nullable().default(null) }).strict()
const recordSchema = z.object({ current: packageSchema, pending: packageSchema.nullable(), enabled: z.boolean(), development: z.boolean() }).strict()
const indexSchema = z.object({ version: z.literal(1), installed: z.record(extensionIdSchema, recordSchema) }).strict()
const grantSchema = z.object({ resource: extensionResourceSchema, target: spaceFileTargetSchema }).strict()
export type ExtensionPackage = z.infer<typeof packageSchema>
export type InstalledExtension = z.infer<typeof recordSchema>
export interface ExtensionCandidate { token: string, package: ExtensionPackage, files: Map<string, Uint8Array>, development: boolean, expires: number }

export class ExtensionPackageStore {
  readonly root: string
  readonly appVersion: string
  readonly resources: ExtensionResourceStore
  readonly #candidates = new Map<string, ExtensionCandidate>()
  readonly #icons = new Map<string, { revision: string, url: Promise<string | undefined> }>()
  #index: z.infer<typeof indexSchema> = { version: 1, installed: {} }
  #tail = Promise.resolve()
  readonly #dataWrites = new Map<string, Promise<void>>()
  #loaded = false

  constructor(root: string, appVersion: string) {
    this.root = root
    this.appVersion = appVersion
    this.resources = new ExtensionResourceStore(root)
  }

  async load(): Promise<void> {
    if (this.#loaded)
      return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      this.#index = indexSchema.parse(await readExtensionJson(join(this.root, 'installed.json')))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('EXTENSION_REGISTRY_UNREADABLE', { cause: error })
    }
    for (const [id, record] of Object.entries(this.#index.installed)) {
      if (record.current.manifest.id !== id || (record.pending && record.pending.manifest.id !== id))
        throw new Error('EXTENSION_REGISTRY_UNREADABLE')
    }
    this.#loaded = true
  }

  get installed(): Readonly<Record<string, InstalledExtension>> {
    return this.#index.installed
  }

  async review(path: string, development = false) {
    const files = development ? await readExtensionDirectory(path) : unpackExtension(await readExtensionFile(path, EXTENSION_PACKAGE_LIMIT))
    return this.reviewFiles(files, development)
  }

  async reviewFiles(files: Map<string, Uint8Array>, development = false, source: z.infer<typeof sourceSchema> | null = null) {
    await this.load()
    validateExtensionFiles(files)
    for (const [token, item] of this.#candidates) {
      if (item.expires < Date.now())
        this.#candidates.delete(token)
    }
    if (this.#candidates.size >= 4)
      throw new Error('EXTENSION_REVIEW_LIMIT')
    let manifest: ExtensionManifest
    try {
      manifest = extensionManifestSchema.parse(JSON.parse(Buffer.from(files.get('extension.json') ?? []).toString('utf8')))
    }
    catch {
      throw new Error('EXTENSION_MANIFEST_INVALID')
    }
    if (!extensionCompatible(manifest, this.appVersion))
      throw new Error('EXTENSION_INCOMPATIBLE')
    for (const entry of [manifest.entry, ...manifest.contributes.views.map(view => view.entry)]) {
      if (entry && (!files.has(entry) || !(manifest.format === 'source' ? /\.m?[jt]s$/.test(entry) : /\.m?js$/.test(entry))))
        throw new Error('EXTENSION_ENTRY_MISSING')
    }
    const current = this.installed[manifest.id]
    if (current && !development && !gt(manifest.version, current.current.manifest.version))
      throw new Error('EXTENSION_VERSION_NOT_NEWER')
    const hashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]))
    const revision = sha256(JSON.stringify(hashes))
    const iconUrl = extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
    const token = randomUUID()
    this.#candidates.set(token, { token, files, development, expires: Date.now() + 600000, package: { manifest, hashes, revision, source } })
    return { token, manifest, iconUrl, sha256: revision, development, currentVersion: current?.current.manifest.version ?? null, addedPermissions: addedExtensionPermissions(current?.current.manifest.permissions, manifest.permissions) }
  }

  cancelReview(token: string): void {
    this.#candidates.delete(token)
  }

  async prepare(token: string, compile: ExtensionCompiler | undefined, signal: AbortSignal, report: (message: string) => void): Promise<boolean> {
    const candidate = this.#candidates.get(token)
    if (!candidate || candidate.expires < Date.now())
      throw new Error('EXTENSION_REVIEW_EXPIRED')
    signal.throwIfAborted()
    if (candidate.package.manifest.format !== 'source')
      return false
    if (!compile)
      throw new Error('EXTENSION_COMPILER_UNAVAILABLE')
    const files = await compile(candidate.files, candidate.package.manifest, signal, report)
    signal.throwIfAborted()
    validateExtensionFiles(files)
    const manifest = extensionManifestSchema.parse(JSON.parse(Buffer.from(files.get('extension.json') ?? []).toString('utf8')))
    const original = candidate.package.manifest
    const expected = { ...original, format: 'compiled', ...(original.entry ? { entry: original.entry.replace(/\.(?:ts|mts)$/, '.js') } : {}), contributes: { ...original.contributes, views: original.contributes.views.map(view => ({ ...view, entry: view.entry.replace(/\.(?:ts|mts)$/, '.js') })) } }
    if (!isDeepStrictEqual(manifest, expected))
      throw new Error('EXTENSION_COMPILE_OUTPUT_INVALID')
    extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
    for (const entry of [manifest.entry, ...manifest.contributes.views.map(view => view.entry)]) {
      if (entry && (!files.has(entry) || !/\.m?js$/.test(entry)))
        throw new Error('EXTENSION_ENTRY_MISSING')
    }
    if (this.#candidates.get(token) !== candidate)
      throw new Error('EXTENSION_INSTALL_CANCELLED')
    const hashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]))
    this.#candidates.set(token, { ...candidate, files, package: { manifest, hashes, revision: sha256(JSON.stringify(hashes)), source: candidate.package.source } })
    return true
  }

  async install(token: string, signal?: AbortSignal): Promise<string> {
    const candidate = this.#candidates.get(token)
    this.#candidates.delete(token)
    if (!candidate || candidate.expires < Date.now())
      throw new Error('EXTENSION_REVIEW_EXPIRED')
    const { package: pkg } = candidate
    signal?.throwIfAborted()
    if (pkg.manifest.format !== 'compiled')
      throw new Error('EXTENSION_COMPILATION_REQUIRED')
    const current = this.installed[pkg.manifest.id]
    if (current && !candidate.development && !gt(pkg.manifest.version, current.current.manifest.version))
      throw new Error('EXTENSION_VERSION_NOT_NEWER')
    const parent = join(this.root, 'packages', pkg.manifest.id)
    const temporary = join(parent, `.install-${randomUUID()}`)
    let created = false
    let committed = false
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    try {
      for (const [name, bytes] of candidate.files) {
        signal?.throwIfAborted()
        const path = join(temporary, name)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600, flush: true })
      }
      try {
        await rename(temporary, this.packageRoot(pkg))
        created = true
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
        for (const [name, hash] of Object.entries(pkg.hashes)) await verifiedExtensionAsset(this.packageRoot(pkg), name, hash)
      }
      await this.#update((index) => {
        signal?.throwIfAborted()
        const old = index.installed[pkg.manifest.id]
        if (old && !candidate.development && !gt(pkg.manifest.version, old.current.manifest.version))
          throw new Error('EXTENSION_VERSION_NOT_NEWER')
        index.installed[pkg.manifest.id] = old
          ? { ...old, pending: pkg, development: candidate.development }
          : { current: pkg, pending: null, enabled: true, development: candidate.development }
      }, () => signal?.throwIfAborted())
      committed = true
      return pkg.manifest.id
    }
    finally {
      await rm(temporary, { recursive: true, force: true })
      if (created && !committed)
        await rm(this.packageRoot(pkg), { recursive: true, force: true })
    }
  }

  async enable(id: string, enabled: boolean): Promise<void> {
    await this.#update((index) => {
      const record = index.installed[id]
      if (!record)
        throw new Error('EXTENSION_NOT_INSTALLED')
      record.enabled = enabled
    })
  }

  async promote(id: string): Promise<void> {
    await this.#update((index) => {
      const record = index.installed[id]
      if (!record)
        throw new Error('EXTENSION_NOT_INSTALLED')
      if (record.pending) {
        record.current = record.pending
        record.pending = null
      }
    })
  }

  async uninstall(id: string): Promise<void> {
    await this.#update((index) => {
      delete index.installed[id]
    })
    this.#icons.delete(id)
  }

  async removePackages(id: string): Promise<void> {
    if (this.installed[id])
      throw new Error('EXTENSION_STILL_INSTALLED')
    await rm(join(this.root, 'packages', extensionIdSchema.parse(id)), { recursive: true, force: true })
  }

  packageRoot(pkg: ExtensionPackage): string {
    return join(this.root, 'packages', pkg.manifest.id, pkg.revision)
  }

  async asset(pkg: ExtensionPackage, path: string): Promise<Uint8Array> {
    const hash = pkg.hashes[path]
    if (!hash)
      throw new Error('EXTENSION_ASSET_MISSING')
    return verifiedExtensionAsset(this.packageRoot(pkg), path, hash)
  }

  async icon(pkg: ExtensionPackage): Promise<string | undefined> {
    const path = pkg.manifest.icon
    if (!path)
      return undefined
    const cached = this.#icons.get(pkg.manifest.id)
    if (cached?.revision === pkg.revision)
      return cached.url
    const url = this.asset(pkg, path).then(bytes => extensionIconUrl(path, bytes)).catch(() => undefined)
    this.#icons.set(pkg.manifest.id, { revision: pkg.revision, url })
    return url
  }

  async grant(id: string, target: z.infer<typeof spaceFileTargetSchema>) {
    const resource = { id: randomUUID(), name: target.path.split('/').at(-1) ?? target.path }
    await writeExtensionJson(join(this.root, 'data', extensionIdSchema.parse(id), 'resources', `${resource.id}.json`), { resource, target })
    return resource
  }

  async resolveGrant(id: string, resourceId: string) {
    const uuid = z.string().uuid().parse(resourceId)
    try {
      return grantSchema.parse(await readExtensionJson(join(this.root, 'data', extensionIdSchema.parse(id), 'resources', `${uuid}.json`))).target
    }
    catch {
      throw new Error('EXTENSION_RESOURCE_DENIED')
    }
  }

  async data(id: string): Promise<{ version: number, value: JsonValue }> {
    try {
      return z.object({ version: z.number().int().min(0), value: z.json() }).strict().parse(await readExtensionJson(join(this.root, 'data', extensionIdSchema.parse(id), 'state.json'), 1024 * 1024))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 0, value: {} }
      throw new Error('EXTENSION_DATA_UNREADABLE')
    }
  }

  async saveData(id: string, value: JsonValue, version: number, assertCurrent: () => void = () => {}): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value)) > 262144)
      throw new Error('EXTENSION_DATA_LIMIT')
    const operation = (this.#dataWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      assertCurrent()
      await writeExtensionJson(join(this.root, 'data', extensionIdSchema.parse(id), 'state.previous.json'), await this.data(id), assertCurrent)
      await writeExtensionJson(join(this.root, 'data', extensionIdSchema.parse(id), 'state.json'), { version, value }, assertCurrent)
    })
    this.#dataWrites.set(id, operation)
    try {
      await operation
    }
    finally {
      if (this.#dataWrites.get(id) === operation)
        this.#dataWrites.delete(id)
    }
  }

  #update(change: (index: z.infer<typeof indexSchema>) => void, assertCurrent: () => void = () => {}): Promise<void> {
    const operation = this.#tail.catch(() => {}).then(async () => {
      if (!this.#loaded)
        throw new Error('EXTENSION_REGISTRY_UNREADABLE')
      const next = structuredClone(this.#index)
      change(next)
      if (Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024)
        throw new Error('EXTENSION_REGISTRY_LIMIT')
      await writeExtensionJson(join(this.root, 'installed.json'), next, assertCurrent)
      this.#index = next
    })
    this.#tail = operation
    return operation
  }
}

export function extensionActivationOrder(installed: Readonly<Record<string, InstalledExtension>>, id: string): string[] {
  const order: string[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  function visit(next: string) {
    if (visiting.has(next))
      throw new Error('EXTENSION_DEPENDENCY_CYCLE')
    if (done.has(next))
      return
    const record = installed[next]
    if (!record?.enabled)
      throw new Error('EXTENSION_DEPENDENCY_UNAVAILABLE')
    visiting.add(next)
    for (const [dependency, range] of Object.entries(record.current.manifest.dependencies)) {
      if (!installed[dependency] || !satisfies(installed[dependency]!.current.manifest.version, range))
        throw new Error('EXTENSION_DEPENDENCY_VERSION')
      visit(dependency)
    }
    visiting.delete(next)
    done.add(next)
    order.push(next)
  }
  visit(id)
  return order
}
