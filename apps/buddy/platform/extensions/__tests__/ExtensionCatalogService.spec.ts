import { rm } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { EXTENSION_CATALOG_URL } from '../../../shared/extensions/extensionCatalog'
import { ExtensionCatalogService } from '../ExtensionCatalogService'
import { sha256 } from '../extensionFiles'
import { createStore, manifest } from './fixtures'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  const { root, store } = await createStore()
  const value = manifest()
  const bytes = zipSync({ 'extension.json': strToU8(JSON.stringify(value)), 'extension.js': strToU8('export function activate() {}'), 'view.js': strToU8('export function render() {}') })
  const artifact = { url: 'https://example.com/plugin.lexora-extension', sha256: sha256(bytes), size: bytes.length }
  const catalog = { schemaVersion: 1, plugins: [{ manifest: value, repository: 'https://example.com/plugins', artifact }] }
  let offline = false
  let tampered = false
  const service = new ExtensionCatalogService(store.root, store.appVersion, async (url) => {
    if (offline)
      throw new Error('Offline')
    if (url === EXTENSION_CATALOG_URL)
      return Response.json(catalog)
    const content = bytes.slice()
    if (tampered)
      content[content.length - 1] ^= 1
    return new Response(content)
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
    tamper: () => { tampered = true },
  }
}

it('uses a cached catalog offline and verifies exact download bytes', async () => {
  const { service, value, bytes, offline } = await fixture()
  const first = await service.list()
  expect(first.plugins[0]).toMatchObject({ compatible: true, manifest: { id: value.id } })
  expect(new Uint8Array((await service.download(value.id, value.version, new AbortController().signal)).bytes)).toEqual(bytes)
  offline()
  const cached = await service.list(true)
  expect(cached).toMatchObject({ stale: true, error: 'EXTENSION_CATALOG_UNAVAILABLE' })
  expect(cached.plugins).toEqual(first.plugins)
})

it('rejects altered downloads and missing versions', async () => {
  const { service, value, tamper } = await fixture()
  await service.list()
  tamper()
  await expect(service.download(value.id, value.version, new AbortController().signal)).rejects.toThrow('EXTENSION_DOWNLOAD_CHECKSUM_FAILED')
  await expect(service.download(value.id, '9.0.0', new AbortController().signal)).rejects.toThrow('EXTENSION_CATALOG_ENTRY_UNAVAILABLE')
})

it('selects the latest compatible release rather than hiding older supported versions', async () => {
  const { service, catalog, value } = await fixture()
  catalog.plugins.push({ ...catalog.plugins[0]!, manifest: manifest({ version: '2.0.0', engines: { lexora: '>=9' } }) })
  expect((await service.list()).plugins[0]?.manifest.version).toBe(value.version)
})
