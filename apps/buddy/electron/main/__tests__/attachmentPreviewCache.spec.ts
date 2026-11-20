import type { AttachmentPreviewResult } from '../../../shared/runtime/attachmentHostProtocol'
import { Buffer } from 'node:buffer'
import { expect, it } from 'vitest'
import { createAttachmentPreviewCache } from '../attachmentPreviewCache'

const signal = new AbortController().signal
function image(text: string) {
  return { data: Buffer.from(text).toString('base64'), mimeType: 'image/png', version: text }
}

it('coalesces panel reads without letting one closed panel cancel the other, then reuses validated bytes', async () => {
  const deferred = Promise.withResolvers<AttachmentPreviewResult>()
  const versions: (string | null)[] = []
  const cache = createAttachmentPreviewCache(async (_id, version) => {
    versions.push(version)
    return version ? { unchanged: version } : deferred.promise
  })
  const controller = new AbortController()
  const first = cache.get('photo', controller.signal)
  const second = cache.get('photo', signal)
  controller.abort()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  deferred.resolve(image('ok'))
  const original = await second
  expect(await original.text()).toBe('ok')
  expect(await cache.get('photo', signal)).toBe(original)
  expect(versions).toEqual([null, 'ok'])
})

it('evicts least recently used bytes and does not serve a cached photo when validation fails', async () => {
  const reads: (string | null)[] = []
  let available = true
  const cache = createAttachmentPreviewCache(async (id, version) => {
    reads.push(version)
    if (!available)
      throw new Error('unavailable')
    return version ? { unchanged: version } : image(id)
  }, 6, 3)
  for (const id of ['aa', 'bb', 'cc', 'aa', 'dddd', 'aa', 'cc'])
    expect(await (await cache.get(id, signal)).text()).toBe(id)
  expect(reads).toEqual([null, null, null, 'aa', null, 'aa', null])
  available = false
  await expect(cache.get('cc', signal)).rejects.toThrow('unavailable')
  available = true
  expect(await (await cache.get('cc', signal)).text()).toBe('cc')
  expect(reads.at(-1)).toBeNull()
})
