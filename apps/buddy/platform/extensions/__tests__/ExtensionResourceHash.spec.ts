import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it, vi } from 'vitest'
import { assertFileSnapshot, fileResponse } from '../../filesystem/fileResponse'
import { ExtensionResourceStore } from '../ExtensionResourceStore'
import { hashResourceResponse } from '../hashResourceResponse'

const extensionId = 'tests.hash'
async function fixture(size = 4 * 1024 * 1024) {
  const root = await createTemporaryDirectory('lexora-resource-hash-')
  const path = join(root, 'model.bin')
  const chunk = Buffer.alloc(64 * 1024, 0x5A)
  const expected = createHash('sha256')
  const handle = await open(path, 'wx')
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const bytes = chunk.subarray(0, Math.min(chunk.length, size - offset))
      await handle.write(bytes)
      expected.update(bytes)
    }
  }
  finally { await handle.close() }
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const [resource] = await store.grant(extensionId, [path], () => {})
  const controller = new AbortController()
  return { root, path, store, resource: resource!, controller, expected: { sha256: expected.digest('hex'), size } }
}

it.each([0, 16 * 1024 * 1024])('streams a %i-byte authorized file without copying or modifying it', async (size) => {
  const f = await fixture(size)
  const before = await stat(f.path, { bigint: true })
  expect(await f.store.hash(extensionId, f.resource.id, f.controller.signal)).toEqual(f.expected)
  const after = await stat(f.path, { bigint: true })
  expect([after.size, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.size, before.ino, before.mtimeNs, before.ctimeNs])
  expect(await f.store.list(extensionId, false)).toEqual([])
})

it('rejects forged, foreign, unpermitted and revoked resource handles', async () => {
  const f = await fixture()
  await expect(f.store.hash(extensionId, randomUUID(), f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.store.hash('tests.other', f.resource.id, f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.store.hash(extensionId, f.resource.id, f.controller.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await f.store.revoke(extensionId, f.resource.id)
  await expect(f.store.hash(extensionId, f.resource.id, f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it('hashes private files without local permission and rejects changed content-addressed assets', async () => {
  const f = await fixture(13)
  const bytes = await readFile(f.path)
  const resource = await f.store.import(extensionId, 'private.bin', 'application/octet-stream', new Response(bytes), f.controller.signal, () => {})
  expect(await f.store.hash(extensionId, resource.id, f.controller.signal, false)).toEqual(f.expected)
  await writeFile(join(f.root, 'extensions', 'data', extensionId, 'files', f.expected.sha256), Buffer.alloc(bytes.length, 7))
  await expect(f.store.hash(extensionId, resource.id, f.controller.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_CHANGED')
})

it.each(['rewrite', 'replace', 'revoke'] as const)('rejects %s after opening the snapshot instead of returning a partial or stale hash', async (change) => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    if (change === 'rewrite') {
      const before = await stat(f.path)
      await writeFile(f.path, Buffer.alloc(f.resource.size, 7))
      await utimes(f.path, before.atime, before.mtime)
    }
    else if (change === 'replace') {
      await rename(f.path, `${f.path}.old`)
      await writeFile(f.path, Buffer.alloc(f.resource.size, 7))
    }
    else {
      await f.store.revoke(extensionId, f.resource.id)
    }
    return result
  })
  await expect(f.store.hash(extensionId, f.resource.id, f.controller.signal)).rejects.toThrow()
})

it('rejects cancellation during final handle close without leaving the stream pending', async () => {
  const f = await fixture(13)
  const handle = await open(f.path, 'r')
  const closing = deferred<void>()
  const release = deferred<void>()
  const original = handle.close.bind(handle)
  vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
    await original()
    closing.resolve()
    await release.promise
  })
  const response = await fileResponse(handle, f.resource.size, 'application/octet-stream', new Request('https://resource.invalid/'), f.controller.signal)
  const rejected = expect(response.arrayBuffer()).rejects.toThrow('CANCEL_DURING_CLOSE')
  await closing.promise
  f.controller.abort(new Error('CANCEL_DURING_CLOSE'))
  release.resolve()
  await rejected
  expect(handle.fd).toBe(-1)
})

it.each(['complete', 'cancel', 'verify-failed', 'abort'] as const)('closes the file handle when a stream is %s', async (ending) => {
  const f = await fixture()
  const handle = await open(f.path, 'r')
  const before = await handle.stat({ bigint: true })
  const response = await fileResponse(handle, f.resource.size, 'application/octet-stream', new Request('https://resource.invalid/'), f.controller.signal, undefined, undefined, async () => {
    await assertFileSnapshot(handle, f.path, before)
    if (ending === 'verify-failed')
      throw new Error('VERIFY_FAILED')
  })
  if (ending === 'complete') {
    expect(await hashResourceResponse(response, f.controller.signal)).toEqual(f.expected)
  }
  else if (ending === 'verify-failed') {
    await expect(hashResourceResponse(response, f.controller.signal)).rejects.toThrow('VERIFY_FAILED')
  }
  else {
    const reader = response.body!.getReader()
    await reader.read()
    if (ending === 'cancel') {
      await reader.cancel()
    }
    else {
      f.controller.abort()
      await expect(reader.read()).rejects.toThrow('RESOURCE_CANCELLED')
    }
    reader.releaseLock()
  }
  await expect.poll(() => handle.fd).toBe(-1)
})
