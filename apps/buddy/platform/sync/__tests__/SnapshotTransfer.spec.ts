import type { SyncAdapter } from '../SyncAdapter'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { resolveBuddyPrivateDirectories } from '../../../platform/native/nativeHost'
import { snapshotManifestSchema } from '../../../shared/storage/snapshot'
import { SnapshotRepository, writeSnapshotManifest } from '../../storage/SnapshotRepository'
import { writeStorageJson } from '../../storage/storageFiles'
import { SnapshotTransfer } from '../SnapshotTransfer'
import { WebDavAdapter } from '../WebDavAdapter'

const privateDirectoriesExecutable = resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false })
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-sync-'))
  directories.push(directory)
  const id = randomUUID()
  const bytes = new TextEncoder().encode('stable snapshot bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const manifest = snapshotManifestSchema.parse({ version: 3, scopes: ['tasks'], credentials: false, id, dataId: randomUUID(), sourceRoot: '/original', createdAt: new Date().toISOString(), databaseVersion: 28, excludedLinks: 0, files: [
    { kind: 'directory', path: 'buddy' },
    { kind: 'file', executable: false, path: 'buddy/buddy.sqlite3', size: bytes.length, hash, chunks: [{ size: bytes.length, hash }] },
  ] })
  const root = join(directory, 'local')
  await mkdir(join(root, id, 'files', 'buddy'), { recursive: true })
  await writeFile(join(root, id, 'files', 'buddy', 'buddy.sqlite3'), bytes)
  await writeStorageJson(join(root, id, 'manifest.json'), manifest)
  const objects = new Map<string, Uint8Array>()
  const adapter: SyncAdapter = {
    remove: async (key) => { objects.delete(key) },
    test: async () => { },
    prepare: async () => { },
    list: async () => [...objects.keys()].filter(key => key.startsWith('snapshots/')).map(key => key.slice(10, -5)),
    read: async key => objects.get(key) ?? null,
    write: async (key, bytes) => {
      objects.set(key, bytes.slice())
    },
  }
  return { directory, root, id, hash, bytes, adapter, objects, manifest }
}
it('publishes a manifest last and restores verified bytes with private executable permissions', async () => {
  const { directory, root, id, bytes, adapter, objects, manifest } = await fixture()
  const path = 'buddy/buddy.sqlite3'
  await chmod(join(root, id, 'files', path), 0o755)
  await writeSnapshotManifest(join(root, id), { ...manifest, files: manifest.files.map(entry => entry.kind === 'file' ? { ...entry, executable: true } : entry) })
  const signal = new AbortController().signal
  await new SnapshotTransfer(adapter, root, () => { }, privateDirectoriesExecutable).upload(id, signal)
  expect([...objects.keys()].at(-1)).toBe(`snapshots/${id}.json`)
  const destination = join(directory, 'download')
  const transfer = new SnapshotTransfer(adapter, destination, () => { }, privateDirectoriesExecutable)
  expect(await transfer.list(signal)).toMatchObject({ snapshots: [{ id, files: 1, bytes: bytes.length }], unreadableIds: [] })
  await transfer.download(id, signal)
  expect(await readFile(join(destination, id, 'files', path))).toEqual(Buffer.from(bytes))
  expect((await new SnapshotRepository(destination).read(id)).files.find(entry => entry.kind === 'file')).toMatchObject({ executable: true })
  if (process.platform !== 'win32')
    expect((await stat(join(destination, id, 'files', path))).mode & 0o7777).toBe(0o700)
})
it('never publishes a failed upload or activates corrupted downloaded bytes', async () => {
  const { directory, root, id, hash, adapter, objects } = await fixture()
  const signal = new AbortController().signal
  await expect(new SnapshotTransfer({ ...adapter, write: async (key, bytes, signal) => {
    if (key.startsWith('objects/'))
      throw new Error('offline')
    await adapter.write(key, bytes, signal)
  } }, root, () => { }).upload(id, signal)).rejects.toThrow('offline')
  expect(objects.has(`snapshots/${id}.json`)).toBe(false)
  await new SnapshotTransfer(adapter, root, () => { }, privateDirectoriesExecutable).upload(id, signal)
  objects.set(`objects/${hash}`, new TextEncoder().encode('corrupt'))
  const destination = join(directory, 'download')
  await expect(new SnapshotTransfer(adapter, destination, () => { }, privateDirectoriesExecutable).download(id, signal)).rejects.toThrow('SYNC_CHECKSUM_FAILED')
  expect(await readdir(destination)).toEqual([])
})
it('rejects traversal, file/directory collisions and device-only files in remote manifests', async () => {
  const { manifest } = await fixture()
  for (const path of ['buddy/../secrets', 'buddy/conversations/a/../../bad', 'buddy/secrets/key', 'buddy/agent/auth.json', 'buddy/conversations/CON', 'buddy/conversations/x:stream'])
    expect(snapshotManifestSchema.safeParse({ ...manifest, files: [...manifest.files, { kind: 'directory', path }] }).success).toBe(false)
  expect(snapshotManifestSchema.safeParse({ ...manifest, files: [...manifest.files, { kind: 'file', path: 'buddy/buddy.sqlite3/evil', size: 0, hash: 'a'.repeat(64), chunks: [] }] }).success).toBe(false)
})
it('reads namespaced WebDAV responses and refuses credentials on redirects', async () => {
  const id = randomUUID()
  const connection = { id: randomUUID(), name: 'fixture', adapter: 'webdav' as const, endpoint: 'https://example.invalid/dav/', username: 'fixture' }
  const adapter = new WebDavAdapter(connection, 'fixture-only', async (url, init) => {
    expect(init.headers.Authorization).toMatch(/^Basic /)
    expect(url).toBe('https://example.invalid/dav/lexora/lexora-backups-v1/snapshots/')
    return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/lexora/lexora-backups-v1/snapshots/${id}.json</d:href></d:response><d:response><d:href>https://untrusted.invalid/${id}.json</d:href></d:response></d:multistatus>`, { status: 207 })
  })
  expect(await adapter.list(new AbortController().signal)).toEqual([id])
  const redirect = new WebDavAdapter(connection, 'fixture-only', async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } }))
  await expect(redirect.test(new AbortController().signal)).rejects.toThrow('SYNC_REDIRECT_REFUSED')
})

it('uses the same manifest capacity locally and remotely and isolates unreadable entries', async () => {
  const { root, id, manifest, adapter, objects } = await fixture()
  const emptyHash = createHash('sha256').digest('hex')
  const large = { ...manifest, files: [...manifest.files, { kind: 'directory' as const, path: 'buddy/conversations' }, ...Array.from({ length: 22000 }, (_, index) => ({ kind: 'file' as const, executable: false, path: `buddy/conversations/${'x'.repeat(80)}-${index}`, size: 0, hash: emptyHash, chunks: [] }))] }
  const bytes = new TextEncoder().encode(JSON.stringify(large))
  expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024)
  await writeSnapshotManifest(join(root, id), large)
  objects.set(`snapshots/${id}.json`, bytes)
  const broken = randomUUID()
  await writeStorageJson(join(root, broken, 'manifest.json'), { broken: true })
  objects.set(`snapshots/${broken}.json`, new TextEncoder().encode('{broken'))
  const repository = new SnapshotRepository(root)
  expect((await repository.read(id)).files).toHaveLength(22003)
  expect(await repository.list()).toMatchObject({ snapshots: [{ id }], unreadableIds: [broken] })
  expect(await new SnapshotTransfer(adapter, root, () => {}, privateDirectoriesExecutable).list(new AbortController().signal)).toMatchObject({ snapshots: [{ id }], unreadableIds: [broken] })
})

it('prunes only this schedules old automatic backups and their private objects, preserving manual and other schedules', async () => {
  const { root, adapter, objects, manifest, bytes } = await fixture()
  const automatic = randomUUID()
  const other = randomUUID()
  const signal = new AbortController().signal
  const transfer = new SnapshotTransfer(adapter, root, () => {}, privateDirectoriesExecutable)
  const manifests = [
    { ...manifest, createdAt: '2026-10-01T00:00:00Z' },
    { ...manifest, id: randomUUID(), automatic, createdAt: '2026-10-02T00:00:00Z' },
    { ...manifest, id: randomUUID(), automatic, createdAt: '2026-10-03T00:00:00Z' },
    { ...manifest, id: randomUUID(), automatic: other, createdAt: '2026-10-01T00:00:00Z' },
  ]
  for (const item of manifests) {
    await mkdir(join(root, item.id, 'files/buddy'), { recursive: true })
    await writeFile(join(root, item.id, 'files/buddy/buddy.sqlite3'), bytes)
    await writeSnapshotManifest(join(root, item.id), item)
    await transfer.upload(item.id, signal)
  }
  await transfer.pruneAutomatic(automatic, 1, signal)
  expect((await transfer.list(signal)).snapshots.map(item => item.id).sort()).toEqual([manifests[0]!.id, manifests[2]!.id, manifests[3]!.id].sort())
  expect([...objects.keys()].some(key => key.includes(manifests[1]!.id))).toBe(false)
  const destination = join(root, 'download')
  const download = new SnapshotTransfer(adapter, destination, () => {}, privateDirectoriesExecutable)
  await download.download(manifests[2]!.id, signal)
  expect(await readFile(join(destination, manifests[2]!.id, 'files/buddy/buddy.sqlite3'))).toEqual(Buffer.from(bytes))
})
