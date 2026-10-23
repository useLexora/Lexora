import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { EXTENSION_CATALOG_URL, extensionCatalogListingSchema } from '../../../shared/extensions/extensionCatalog'
import { EXTENSION_ARCHIVE_LIMIT, EXTENSION_EXPANDED_LIMIT, EXTENSION_FILE_LIMIT, validateExtensionArchiveSize, validateExtensionFileCounts, validateExtensionFiles } from '../../../shared/extensions/extensionPackageBudget'
import { buildExtensionArchive } from '../buildExtensionPackage'
import { ExtensionCatalogService } from '../ExtensionCatalogService'
import { readExtensionDirectory, sha256, unpackExtension } from '../extensionFiles'
import { createStore, manifest } from './fixtures'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('separates exact archive, file, expanded and file-count budgets', () => {
  expect(() => validateExtensionArchiveSize(EXTENSION_ARCHIVE_LIMIT)).not.toThrow()
  expect(() => validateExtensionArchiveSize(EXTENSION_ARCHIVE_LIMIT + 1)).toThrow('EXTENSION_ARCHIVE_LIMIT')
  const large = new Uint8Array(EXTENSION_FILE_LIMIT)
  const files = new Map(Array.from({ length: EXTENSION_EXPANDED_LIMIT / EXTENSION_FILE_LIMIT }, (_, index) => [`${index}.wasm`, large]))
  expect(() => validateExtensionFiles(files)).not.toThrow()
  files.set('extra.wasm', new Uint8Array(1))
  expect(() => validateExtensionFiles(files)).toThrow('EXTENSION_PACKAGE_LIMIT')
  expect(() => validateExtensionFiles(new Map([['large.wasm', new Uint8Array(EXTENSION_FILE_LIMIT + 1)]]))).toThrow('EXTENSION_PACKAGE_LIMIT')
  expect(() => validateExtensionFileCounts(Array.from({ length: 512 }, (_, index) => `${index}.wasm`))).not.toThrow()
  expect(() => validateExtensionFileCounts(Array.from({ length: 513 }, (_, index) => `${index}.wasm`))).toThrow('EXTENSION_PACKAGE_LIMIT')
  expect(() => validateExtensionFileCounts(Array.from({ length: 4096 }, (_, index) => `${index}.svg`))).not.toThrow()
  expect(() => validateExtensionFileCounts(Array.from({ length: 4097 }, (_, index) => `${index}.svg`))).toThrow('EXTENSION_PACKAGE_LIMIT')
})

it('rejects oversized archive bytes and forged expanded sizes before accepting content', () => {
  expect(() => unpackExtension(new Uint8Array(EXTENSION_ARCHIVE_LIMIT + 1))).toThrow('EXTENSION_ARCHIVE_LIMIT')
  const archive = zipSync({ 'inflated.wasm': new Uint8Array(8 * 1024 * 1024) })
  new DataView(archive.buffer, archive.byteOffset).setUint32(22, 1, true)
  expect(() => unpackExtension(archive)).toThrow('EXTENSION_PACKAGE_LIMIT')
  new DataView(archive.buffer, archive.byteOffset).setUint32(22, EXTENSION_FILE_LIMIT + 1, true)
  expect(() => unpackExtension(archive)).toThrow('EXTENSION_UNSAFE_PACKAGE')
  const tooMany = zipSync(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`${index}.js`, new Uint8Array()])))
  expect(() => unpackExtension(tooMany)).toThrow('EXTENSION_PACKAGE_LIMIT')
})

it('bounds actual inflation even when streaming ZIP entries omit their original sizes', () => {
  function bomb(sizes: number[]) {
    const chunks: Uint8Array[] = []
    const zip = new Zip((error, bytes) => {
      if (error)
        throw error
      chunks.push(bytes)
    })
    const zeros = new Uint8Array(1024 * 1024)
    for (const [index, size] of sizes.entries()) {
      const entry = new ZipDeflate(`${index}.wasm`)
      zip.add(entry)
      for (let offset = 0; offset < size; offset += zeros.length)
        entry.push(zeros.subarray(0, Math.min(zeros.length, size - offset)), offset + zeros.length >= size)
    }
    zip.end()
    return Buffer.concat(chunks)
  }
  expect(() => unpackExtension(bomb([EXTENSION_FILE_LIMIT + 1]))).toThrow('EXTENSION_PACKAGE_LIMIT')
  expect(() => unpackExtension(bomb([EXTENSION_FILE_LIMIT, EXTENSION_FILE_LIMIT, EXTENSION_FILE_LIMIT, EXTENSION_FILE_LIMIT, 1]))).toThrow('EXTENSION_PACKAGE_LIMIT')
})

it('builds, downloads, reviews and installs a real archive above the former file, archive and inline budgets', async () => {
  const { root, store } = await createStore()
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  const value = manifest()
  const binary = randomBytes(20 * 1024 * 1024)
  const input = new Map([
    ['extension.json', strToU8(JSON.stringify(value))],
    ['extension.js', strToU8('export function activate() {}')],
    ['view.js', strToU8('export function render() {}')],
    ['module.wasm', binary],
  ])
  for (const [name, bytes] of input)
    await writeFile(join(source, name), bytes)
  const directory = await readExtensionDirectory(source)
  const built = await buildExtensionArchive(zipSync(Object.fromEntries(directory)), async files => files, new AbortController().signal)
  expect(built.ok).toBe(true)
  if (!built.ok)
    throw new Error(built.code)
  expect(built.archive.length).toBeGreaterThan(18 * 1024 * 1024)
  const entry = { manifest: value, repository: 'https://example.com/plugins', artifact: { url: 'https://example.com/plugin.lexora-extension', sha256: sha256(built.archive), size: built.archive.byteLength } }
  expect(extensionCatalogListingSchema.safeParse({ ...entry, artifact: { ...entry.artifact, size: EXTENSION_ARCHIVE_LIMIT } }).success).toBe(true)
  expect(extensionCatalogListingSchema.safeParse({ ...entry, artifact: { ...entry.artifact, size: EXTENSION_ARCHIVE_LIMIT + 1 } }).success).toBe(false)
  const catalog = new ExtensionCatalogService(store.root, store.appVersion, async url => url === EXTENSION_CATALOG_URL ? Response.json({ schemaVersion: 1, plugins: [entry] }) : new Response(built.archive))
  try {
    const downloaded = await catalog.download(value.id, value.version, new AbortController().signal)
    const review = await store.reviewFiles(unpackExtension(downloaded.bytes))
    await store.install(review.token)
    expect(sha256(await store.asset(store.installed[value.id]!.current, 'module.wasm'))).toBe(sha256(binary))
  }
  finally {
    catalog.dispose()
  }
})

it('rejects an oversized directory file before reading it and detects altered review bytes', async () => {
  const { root, store } = await createStore()
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'large.wasm'), '')
  await truncate(join(source, 'large.wasm'), EXTENSION_FILE_LIMIT + 1)
  await expect(readExtensionDirectory(source)).rejects.toThrow('EXTENSION_FILE_LIMIT')
  const bytes = strToU8('export function activate() {}')
  const files = new Map([['extension.json', strToU8(JSON.stringify(manifest()))], ['extension.js', bytes], ['view.js', strToU8('')]])
  const review = await store.reviewFiles(files)
  bytes[0] ^= 1
  await expect(store.install(review.token)).rejects.toThrow('EXTENSION_PACKAGE_CHANGED')
  expect(store.installed).toEqual({})
})

it('bounds retained review bytes in addition to review count without rejecting a valid package in an empty cache', async () => {
  const { root, store } = await createStore()
  roots.push(root)
  const binary = new Uint8Array(EXTENSION_FILE_LIMIT)
  const files = new Map([['extension.json', strToU8(JSON.stringify(manifest()))], ['extension.js', strToU8('')], ['view.js', strToU8('')], ['one.wasm', binary], ['two.wasm', binary], ['three.wasm', binary]])
  const first = await store.reviewFiles(files)
  await expect(store.reviewFiles(files)).rejects.toThrow('EXTENSION_REVIEW_BYTES_LIMIT')
  store.cancelReview(first.token)
  const next = await store.reviewFiles(files)
  expect(next.sha256).toBe(first.sha256)
})
