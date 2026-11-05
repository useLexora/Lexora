import { Buffer } from 'node:buffer'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { ExtensionResourceStore } from '../../../../platform/extensions/ExtensionResourceStore'
import { hashResourceResponse } from '../../../../platform/extensions/hashResourceResponse'
import { readSpaceFileResource } from '../readSpaceFileResource'

it('stops a large Space hash on bounded authorization revalidation before reaching EOF', async () => {
  const root = await createTemporaryDirectory('lexora-space-hash-')
  const path = join(root, 'model.bin')
  const handle = await open(path, 'w')
  await handle.truncate(32 * 1024 * 1024)
  await handle.close()
  let allowed = true
  const signal = new AbortController().signal
  const response = await readSpaceFileResource({ spaceId: 'space', directoryId: 'directory', revision: 1, path: 'model.bin' }, signal, async () => {
    if (!allowed)
      throw new Error('FILE_PERMISSION_REVOKED')
    return { path, kind: 'file' }
  })
  let consumed = 0
  const body = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    consumed += chunk.length
    allowed = false
    controller.enqueue(chunk)
  } }))
  await expect(hashResourceResponse(new Response(body, { headers: response.headers }), signal)).rejects.toThrow('FILE_PERMISSION_REVOKED')
  expect(consumed).toBeGreaterThan(0)
  expect(consumed).toBeLessThanOrEqual(8 * 1024 * 1024)
})

it('rejects same-length changes during a Space hash', async () => {
  const root = await createTemporaryDirectory('lexora-space-hash-')
  const path = join(root, 'model.bin')
  await writeFile(path, Buffer.alloc(256 * 1024, 1))
  const signal = new AbortController().signal
  const response = await readSpaceFileResource({ spaceId: 'space', directoryId: 'directory', revision: 1, path: 'model.bin' }, signal, async () => ({ path, kind: 'file' }))
  await writeFile(path, Buffer.alloc(256 * 1024, 2))
  await expect(hashResourceResponse(response, signal)).rejects.toThrow('RESOURCE_FILE_CHANGED')
})

it('revalidates an empty Space file before returning its hash', async () => {
  const root = await createTemporaryDirectory('lexora-space-hash-')
  const path = join(root, 'empty.bin')
  await writeFile(path, '')
  let reads = 0
  await expect(readSpaceFileResource({ spaceId: 'space', directoryId: 'directory', revision: 1, path: 'empty.bin' }, new AbortController().signal, async () => {
    if (reads++)
      throw new Error('FILE_PERMISSION_REVOKED')
    return { path, kind: 'file' }
  })).rejects.toThrow('FILE_PERMISSION_REVOKED')
})

it('copies an authorized Space image without text decoding or another selection and checks authorization again before publishing it', async () => {
  const root = await createTemporaryDirectory('lexora-space-resource-')
  const path = join(root, 'wallpaper.png')
  const bytes = Buffer.from([0, 255, 42, 128])
  await writeFile(path, bytes)
  const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'wallpaper.png' }
  const signal = new AbortController().signal
  let allowed = true
  const locate = async () => {
    if (!allowed)
      throw new Error('FILE_PERMISSION_REVOKED')
    return { path, kind: 'file' as const }
  }
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const response = await readSpaceFileResource(target, signal, locate)
  const resource = await store.import('tests.images', 'wallpaper.png', 'image/png', response, signal, () => {})
  expect(await store.readBytes('tests.images', resource.id, 0, 4, signal, false)).toMatchObject({ base64: bytes.toString('base64'), eof: true })
  const part = await readSpaceFileResource(target, signal, locate, new Request('https://resource.invalid/', { headers: { range: 'bytes=1-2' } }))
  expect(part.status).toBe(206)
  expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(1, 3))
  const head = await readSpaceFileResource(target, signal, locate, new Request('https://resource.invalid/', { method: 'HEAD' }))
  expect(head.headers.get('content-length')).toBe('4')
  expect(head.body).toBeNull()
  expect((await readSpaceFileResource(target, signal, locate, new Request('https://resource.invalid/', { headers: { range: 'bytes=99-' } }))).status).toBe(416)
  const revoked = await readSpaceFileResource(target, signal, locate)
  allowed = false
  await expect(store.import('tests.images', 'revoked.png', 'image/png', revoked, signal, () => {})).rejects.toThrow('FILE_PERMISSION_REVOKED')
  expect(await store.list('tests.images', false)).toEqual([resource])
  expect(await readFile(path)).toEqual(bytes)
})
