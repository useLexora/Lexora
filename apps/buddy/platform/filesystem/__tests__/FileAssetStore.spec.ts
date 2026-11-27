import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { link, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it, vi } from 'vitest'
import { FileAssetStore } from '../FileAssetStore'
import * as fileResponse from '../fileResponse'

const signal = () => new AbortController().signal
function current() {}
const put = (store: FileAssetStore, bytes: string) => store.put(new Response(bytes).body!, signal(), current)

it('reuses verified identical content without replacing a live file or its inode', async () => {
  const root = await createTemporaryDirectory('lexora-file-assets-')
  const store = new FileAssetStore(root)
  const asset = await put(store, 'weights')
  const path = store.path(asset.key)
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    expect(await put(new FileAssetStore(root), 'weights')).toEqual(asset)
    const after = await stat(path, { bigint: true })
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs])
    expect(await handle.readFile('utf8')).toBe('weights')
  }
  finally { await handle.close() }
  expect(await readdir(root)).toEqual([asset.key])
})

it('concurrently publishes one complete immutable object across store instances', async () => {
  const root = await createTemporaryDirectory('lexora-file-assets-race-')
  const bytes = 'weights'.repeat(20000)
  const results = await Promise.all(Array.from({ length: 6 }, () => put(new FileAssetStore(root), bytes)))
  const key = createHash('sha256').update(bytes).digest('hex')
  expect(results).toEqual(Array.from({ length: 6 }, () => ({ key, size: Buffer.byteLength(bytes) })))
  expect(await readdir(root)).toEqual([key])
  expect(await readFile(new FileAssetStore(root).path(key), 'utf8')).toBe(bytes)
})

it.each([false, true])('revalidates a completed hard-link view cycle with continuous metadata changes=%s', async (continuous) => {
  const root = await createTemporaryDirectory('lexora-file-assets-view-')
  const store = new FileAssetStore(root)
  const bytes = 'synthetic'.repeat(20000)
  const asset = await put(store, bytes)
  const before = await stat(store.path(asset.key), { bigint: true })
  let cycles = 0
  const verify = fileResponse.assertFileSnapshot
  using checkpoint = vi.spyOn(fileResponse, 'assertFileSnapshot')
  checkpoint.mockImplementation(async (handle, path, snapshot) => {
    await verify(handle, path, snapshot)
    if (cycles && !continuous)
      return
    const view = join(root, 'lease-view')
    await link(path, view)
    await unlink(view)
    cycles++
    // Model an observable ctime change even when a completed link cycle fits in one filesystem tick.
    const after = await handle.stat({ bigint: true })
    after.ctimeNs = snapshot.ctimeNs + 1n
    vi.spyOn(handle, 'stat').mockResolvedValueOnce(after)
  })
  const publication = put(store, bytes)
  if (continuous)
    await expect(publication).rejects.toThrow('RESOURCE_FILE_CHANGED')
  else
    expect(await publication).toEqual(asset)
  expect(cycles).toBe(continuous ? 2 : 1)
  const after = await stat(store.path(asset.key), { bigint: true })
  expect([after.dev, after.ino, after.nlink, after.mtimeNs]).toEqual([before.dev, before.ino, before.nlink, before.mtimeNs])
  expect(await readFile(store.path(asset.key), 'utf8')).toBe(bytes)
  expect(await readdir(root)).toEqual([asset.key])
})

it('rejects corrupt existing content instead of replacing an object used by other readers', async () => {
  const root = await createTemporaryDirectory('lexora-file-assets-integrity-')
  const store = new FileAssetStore(root)
  const asset = await put(store, 'weights')
  await writeFile(store.path(asset.key), 'corrupt')
  await expect(put(store, 'weights')).rejects.toThrow('RESOURCE_ASSET_INVALID')
  expect(await readFile(store.path(asset.key), 'utf8')).toBe('corrupt')
  expect(await readdir(root)).toEqual([asset.key])
})
