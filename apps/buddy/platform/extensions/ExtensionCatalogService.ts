import type { ExtensionCatalogEntry, ExtensionCatalogListing, ExtensionCatalogSnapshot } from '../../shared/extensions/extensionCatalog'
import { join } from 'node:path'
import { rcompare } from 'semver'
import { z } from 'zod'
import { EXTENSION_CATALOG_URL, extensionCatalogEntrySchema, extensionCatalogListingSchema, extensionCatalogSchema } from '../../shared/extensions/extensionCatalog'
import { ExtensionCompatibilityError, extensionCompatibilityIssue } from '../../shared/extensions/extensionCompatibility'
import { publicWebUrl, readResponseBytes } from '../network/publicWebTransport'
import { readExtensionJson, sha256, writeExtensionJson } from './extensionFiles'

const cacheSchema = z.object({ cachedAt: z.string(), catalog: extensionCatalogSchema }).strict()
export class ExtensionCatalogService {
  readonly #path: string
  readonly #version: string
  readonly #get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  #cache: z.infer<typeof cacheSchema> | null = null
  #loading: Promise<void> | null = null
  #refreshing: Promise<ExtensionCatalogSnapshot> | null = null
  readonly #abort = new AbortController()
  readonly #checksum: (bytes: Uint8Array, signal: AbortSignal) => Promise<string>

  constructor(root: string, version: string, get: (url: string, init: { signal: AbortSignal }) => Promise<Response>, checksum: (bytes: Uint8Array, signal: AbortSignal) => Promise<string> = async bytes => sha256(bytes)) {
    this.#path = join(root, 'catalog.json')
    this.#version = version
    this.#get = get
    this.#checksum = checksum
  }

  async list(refresh = false): Promise<ExtensionCatalogSnapshot> {
    await (this.#loading ??= readExtensionJson(this.#path, 4 * 1024 * 1024).then((raw) => {
      this.#cache = cacheSchema.parse(raw)
    }).catch(() => {}))
    if (!refresh && this.#cache && Date.now() - Date.parse(this.#cache.cachedAt) < 3600000)
      return this.#snapshot(false, null)
    return this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null
    })
  }

  async download(id: string, version: string, signal: AbortSignal): Promise<{ entry: ExtensionCatalogEntry, bytes: Uint8Array }> {
    await this.list()
    if (this.#snapshot(false, null).plugins.find(item => item.manifest.id === id)?.manifest.version !== version)
      throw new Error('EXTENSION_CATALOG_ENTRY_UNAVAILABLE')
    const raw = this.#cache?.catalog.plugins.find((item) => {
      const parsed = extensionCatalogListingSchema.safeParse(item)
      return parsed.success && parsed.data.manifest.id === id && parsed.data.manifest.version === version
    })
    if (!raw)
      throw new Error('EXTENSION_CATALOG_ENTRY_UNAVAILABLE')
    const listing = extensionCatalogListingSchema.parse(raw)
    const issue = extensionCompatibilityIssue(listing.manifest, this.#version)
    if (issue)
      throw new ExtensionCompatibilityError(listing.manifest, issue)
    const parsed = extensionCatalogEntrySchema.safeParse(raw)
    if (!parsed.success)
      throw new Error('EXTENSION_MANIFEST_INVALID')
    const entry = parsed.data
    const bytes = await this.#fetch(entry.artifact.url, entry.artifact.size, signal)
    const checking = AbortSignal.any([signal, this.#abort.signal])
    checking.throwIfAborted()
    if (bytes.byteLength !== entry.artifact.size || await this.#checksum(bytes, checking) !== entry.artifact.sha256)
      throw new Error('EXTENSION_DOWNLOAD_CHECKSUM_FAILED')
    checking.throwIfAborted()
    return { entry, bytes }
  }

  dispose(): void {
    this.#abort.abort()
  }

  async #refresh(): Promise<ExtensionCatalogSnapshot> {
    try {
      const bytes = await this.#fetch(EXTENSION_CATALOG_URL, 2 * 1024 * 1024, this.#abort.signal)
      const catalog = extensionCatalogSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
      const next = { catalog, cachedAt: new Date().toISOString() }
      await writeExtensionJson(this.#path, next, () => this.#abort.signal.throwIfAborted())
      this.#cache = next
      return this.#snapshot(false, null)
    }
    catch {
      return this.#snapshot(true, 'EXTENSION_CATALOG_UNAVAILABLE')
    }
  }

  #snapshot(stale: boolean, error: string | null): ExtensionCatalogSnapshot {
    const selected = new Map<string, ExtensionCatalogListing>()
    let invalidEntries = 0
    const entries = (this.#cache?.catalog.plugins ?? []).flatMap((raw) => {
      const parsed = extensionCatalogListingSchema.safeParse(raw)
      if (!parsed.success) {
        invalidEntries++
        return []
      }
      return [{ raw, entry: parsed.data }]
    })
    for (const { raw, entry } of entries.sort((a, b) => rcompare(a.entry.manifest.version, b.entry.manifest.version))) {
      const incompatibility = extensionCompatibilityIssue(entry.manifest, this.#version) ?? (extensionCatalogEntrySchema.safeParse(raw).success ? null : { reason: 'manifest-invalid' as const, currentVersion: this.#version, requiredVersion: entry.manifest.engines.lexora, requiredApiVersion: entry.manifest.apiVersion })
      const compatible = !incompatibility
      const previous = selected.get(entry.manifest.id)
      if (!previous)
        selected.set(entry.manifest.id, { ...entry, compatible, incompatibility })
    }
    return { plugins: [...selected.values()], invalidEntries, cachedAt: this.#cache?.cachedAt ?? null, stale, error }
  }

  async #fetch(raw: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    let url = raw
    const bounded = AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(30000)])
    for (let redirects = 0; redirects < 5; redirects++) {
      const parsed = publicWebUrl(url)
      if (parsed.protocol !== 'https:')
        throw new Error('EXTENSION_DOWNLOAD_URL_DENIED')
      const response = await this.#get(parsed.href, { signal: bounded })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location)
          break
        url = new URL(location, parsed).href
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('EXTENSION_DOWNLOAD_FAILED')
      }
      return readResponseBytes(response, limit)
    }
    throw new Error('EXTENSION_DOWNLOAD_FAILED')
  }
}
