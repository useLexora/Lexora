import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { EXTENSION_CATALOG_URL } from '../../../shared/extensions/extensionCatalog'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../../shared/network/downloadSettings'
import { ExtensionCatalogService } from '../ExtensionCatalogService'
import { sha256 } from '../extensionFiles'
import { ExtensionPackageStore } from '../ExtensionPackageStore'
import { createStore, manifest } from './fixtures'

const cleanup: Array<() => Promise<void>> = []
function archive(value: ReturnType<typeof manifest>, files: Record<string, Uint8Array> = {}) {
  return zipSync({ 'extension.json': strToU8(JSON.stringify(value)), 'extension.js': strToU8('export function activate() {}'), 'view.js': strToU8('export function render() {}'), ...files })
}
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  const { root, store } = await createStore()
  const value = manifest()
  const bytes = archive(value)
  const artifact = { url: 'https://example.com/plugin.lexora-extension', sha256: sha256(bytes), size: bytes.length }
  const catalog = { schemaVersion: 1, plugins: [{ manifest: value, repository: 'https://example.com/plugins', artifact }] }
  let offline = false
  let served = bytes
  const service = new ExtensionCatalogService(store.root, store.appVersion, async (url) => {
    if (offline)
      throw new Error('Offline')
    if (url === EXTENSION_CATALOG_URL)
      return Response.json(catalog)
    return new Response(served.slice())
  })
  cleanup.push(async () => {
    service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    store,
    value,
    catalog,
    bytes,
    offline: () => { offline = true },
    replace: (bytes: Uint8Array) => { served = bytes.slice() },
  }
}

it('binds risk confirmation to the reviewed snapshot and retains actual integrity evidence after restart', async () => {
  const { service, store, value, replace } = await fixture()
  await service.list()
  const actual = manifest({ permissions: { selectedResource: 'read', network: ['https://changed.example.com'] } })
  const bytes = archive(actual)
  replace(bytes)
  const signal = new AbortController().signal
  const downloaded = await service.download(value.id, value.version, signal)
  expect(downloaded.source).toMatchObject({ sha256: sha256(bytes), mismatch: { expectedSha256: downloaded.entry.artifact.sha256, expectedSize: downloaded.entry.artifact.size, actualSize: bytes.length } })
  const review = await store.reviewArchive(downloaded.bytes, downloaded.source, downloaded.entry.manifest, signal)
  expect(review.manifest.permissions.network).toEqual(['https://changed.example.com'])
  expect(review.addedPermissions).toContain('network:https://changed.example.com')
  await expect(store.prepare(review.token, undefined, signal, () => {})).rejects.toThrow('EXTENSION_UNVERIFIED_CONFIRMATION_REQUIRED')
  await expect(store.install(review.token)).rejects.toThrow('EXTENSION_UNVERIFIED_CONFIRMATION_REQUIRED')
  expect(store.installed[value.id]).toBeUndefined()
  downloaded.bytes.fill(0)
  replace(archive(manifest({ version: '9.0.0' })))
  await store.install(review.token, signal, [], true)
  const reloaded = new ExtensionPackageStore(store.root, store.appVersion)
  await reloaded.load()
  const pkg = reloaded.installed[value.id]!.current
  expect(pkg.source).toEqual(downloaded.source)
  expect(pkg.manifest).toEqual(actual)
  expect(new TextDecoder().decode(await reloaded.asset(pkg, 'view.js'))).toBe('export function render() {}')
  await writeFile(join(reloaded.packageRoot(pkg), 'view.js'), 'changed after installation')
  await expect(reloaded.asset(pkg, 'view.js')).rejects.toThrow('EXTENSION_PACKAGE_CHANGED')
  await expect(service.download(value.id, '9.0.0', new AbortController().signal)).rejects.toThrow('EXTENSION_CATALOG_ENTRY_UNAVAILABLE')
})

it.each([
  ['identity', () => archive(manifest({ id: 'tests.other' })), 'EXTENSION_CATALOG_MANIFEST_MISMATCH'],
  ['version', () => archive(manifest({ version: '1.0.1' })), 'EXTENSION_CATALOG_MANIFEST_MISMATCH'],
  ['compatibility', () => archive(manifest({ engines: { lexora: '>=9' } })), 'EXTENSION_INCOMPATIBLE'],
  ['unsafe paths', () => archive(manifest(), { '../escape.js': strToU8('unsafe') }), 'EXTENSION_UNSAFE_PACKAGE'],
  ['malformed archive', () => strToU8('not a package'), 'EXTENSION_INVALID_ARCHIVE'],
])('does not relax %s checks for an unverified package', async (_name, content, error) => {
  const { service, store, value, replace } = await fixture()
  replace(content())
  const signal = new AbortController().signal
  const downloaded = await service.download(value.id, value.version, signal)
  expect(downloaded.source.mismatch).toBeDefined()
  await expect(store.reviewArchive(downloaded.bytes, downloaded.source, downloaded.entry.manifest, signal)).rejects.toThrow(error)
  expect(store.installed[value.id]).toBeUndefined()
})

it('requires the catalog manifest to match packages whose bytes are verified', async () => {
  const { service, store, catalog, value } = await fixture()
  catalog.plugins[0]!.manifest = manifest({ name: 'Different catalog metadata' })
  const signal = new AbortController().signal
  const downloaded = await service.download(value.id, value.version, signal)
  expect(downloaded.source.mismatch).toBeUndefined()
  await expect(store.reviewArchive(downloaded.bytes, downloaded.source, downloaded.entry.manifest, signal)).rejects.toThrow('EXTENSION_CATALOG_MANIFEST_MISMATCH')
})

it('shows only the latest release and refuses older marketplace versions', async () => {
  const { service, catalog, value } = await fixture()
  catalog.plugins.push({ ...catalog.plugins[0]!, manifest: manifest({ version: '2.0.0', engines: { lexora: '>=9' } }) })
  expect((await service.list()).plugins).toMatchObject([{ manifest: { version: '2.0.0' }, compatible: false, incompatibility: { reason: 'app-too-old', requiredVersion: '>=9' } }])
  await expect(service.download(value.id, value.version, new AbortController().signal)).rejects.toThrow('EXTENSION_CATALOG_ENTRY_UNAVAILABLE')
  await expect(service.download(value.id, '2.0.0', new AbortController().signal)).rejects.toMatchObject({ review: { incompatibility: { reason: 'app-too-old' } } })
})

it('isolates future APIs and invalid entries while preserving exact supported downloads and offline metadata', async () => {
  const { service, catalog, value, bytes, offline } = await fixture()
  const raw = catalog.plugins as unknown[]
  raw.push({ ...catalog.plugins[0], manifest: { ...value, id: 'tests.future', apiVersion: 5, engines: { lexora: '*' }, contributes: { futureCapability: {} } } })
  raw.push({ ...catalog.plugins[0], manifest: { ...value, id: 'tests.invalid', engines: { lexora: '*' }, futureField: true } })
  raw.push({ broken: true })
  const first = await service.list()
  expect(first).toMatchObject({ stale: false, error: null, invalidEntries: 1 })
  expect(first.plugins.find(item => item.manifest.id === 'tests.future')).toMatchObject({ compatible: false, incompatibility: { reason: 'api-unsupported' } })
  expect(first.plugins.find(item => item.manifest.id === 'tests.invalid')).toMatchObject({ compatible: false, incompatibility: { reason: 'manifest-invalid' } })
  const download = await service.download(value.id, value.version, new AbortController().signal)
  expect(download.entry.manifest.id).toBe(value.id)
  expect(new Uint8Array(download.bytes)).toEqual(bytes)
  await expect(service.download('tests.future', value.version, new AbortController().signal)).rejects.toMatchObject({ review: { incompatibility: { reason: 'api-unsupported' } } })
  await expect(service.download('tests.invalid', value.version, new AbortController().signal)).rejects.toThrow('EXTENSION_MANIFEST_INVALID')
  offline()
  const cached = await service.list(true)
  expect(cached).toMatchObject({ stale: true, error: 'EXTENSION_CATALOG_UNAVAILABLE' })
  expect(cached.plugins).toEqual(first.plugins)
})

const GITHUB_ARTIFACT = 'https://github.com/useLexora/plugins/releases/download/plugin/plugin.lexora-extension'
async function mirrorFixture(downloadMirror: 'auto' | 'off', respond: (url: string, bytes: Uint8Array) => Response) {
  const { root, store } = await createStore()
  const value = manifest()
  const bytes = zipSync({ 'extension.json': strToU8(JSON.stringify(value)), 'extension.js': strToU8('export function activate() {}'), 'view.js': strToU8('export function render() {}') })
  const catalog = { schemaVersion: 1, plugins: [{ manifest: value, repository: 'https://example.com/plugins', artifact: { url: GITHUB_ARTIFACT, sha256: sha256(bytes), size: bytes.length } }] }
  const requests: string[] = []
  const service = new ExtensionCatalogService(store.root, store.appVersion, async (url) => {
    requests.push(url)
    return url === EXTENSION_CATALOG_URL ? Response.json(catalog) : respond(url, bytes)
  }, undefined, () => ({ ...DEFAULT_DOWNLOAD_SETTINGS, enabled: downloadMirror === 'auto' }))
  cleanup.push(async () => {
    service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await service.list()
  expect(requests).toEqual([EXTENSION_CATALOG_URL])
  requests.length = 0
  return { service, value, bytes, requests }
}

it('downloads packages through a mirror first, skipping one that alters the file or fails', async () => {
  const { service, value, bytes, requests } = await mirrorFixture('auto', (url, content) => {
    if (url === `${DEFAULT_DOWNLOAD_SETTINGS.proxies[0]!.url}${GITHUB_ARTIFACT}`)
      return new Response(null, { status: 503 })
    return new Response(url.startsWith(DEFAULT_DOWNLOAD_SETTINGS.proxies[1]!.url) ? content.slice().reverse() : content)
  })
  const result = await service.download(value.id, value.version, new AbortController().signal)
  expect(new Uint8Array(result.bytes)).toEqual(bytes)
  expect(requests).toEqual([`${DEFAULT_DOWNLOAD_SETTINGS.proxies[0]!.url}${GITHUB_ARTIFACT}`, `${DEFAULT_DOWNLOAD_SETTINGS.proxies[1]!.url}${GITHUB_ARTIFACT}`, `${DEFAULT_DOWNLOAD_SETTINGS.proxies[2]!.url}${GITHUB_ARTIFACT}`])
})

it('downloads packages from GitHub only when mirrors are off', async () => {
  const { service, value, requests } = await mirrorFixture('off', (_url, content) => new Response(content))
  await service.download(value.id, value.version, new AbortController().signal)
  expect(requests).toEqual([GITHUB_ARTIFACT])
})

it('uses the origin package for risk review after all mirrors return altered content', async () => {
  const { service, value, requests } = await mirrorFixture('auto', (url, content) => new Response(url === GITHUB_ARTIFACT ? archive(manifest({ name: 'Republished package' })) : content.slice().reverse()))
  const result = await service.download(value.id, value.version, new AbortController().signal)
  expect(requests.at(-1)).toBe(GITHUB_ARTIFACT)
  expect(result.source).toMatchObject({ artifact: GITHUB_ARTIFACT, sha256: sha256(result.bytes), mismatch: { actualSize: result.bytes.length } })
})

it('does not offer a corrupt mirror package when the origin cannot be reached', async () => {
  const { service, value } = await mirrorFixture('auto', (url, content) => {
    if (url === GITHUB_ARTIFACT)
      throw new Error('Offline')
    return new Response(content.slice().reverse())
  })
  await expect(service.download(value.id, value.version, new AbortController().signal)).rejects.toThrow('EXTENSION_DOWNLOAD_FAILED')
})
