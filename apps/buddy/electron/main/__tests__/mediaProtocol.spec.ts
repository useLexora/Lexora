import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMediaPreview } from '../../../service/src/files/resolveMediaPreview'
import { taskFileMediaUrl } from '../../../shared/files/mediaPreview'
import { taskFilesRpc } from '../../../shared/files/taskFileApi'
import { createMediaResponse, handleMediaRequest } from '../mediaProtocol'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(bytes = Buffer.from('0123456789'), name = 'clip.mp4') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-media-')))
  directories.push(root)
  const path = join(root, name)
  await writeFile(path, bytes)
  const resolve = () => resolveMediaPreview(root, path)
  const request = (range?: string, method = 'GET', signal?: AbortSignal) => new Request('lexora-artifact://media/clip', {
    method,
    signal,
    headers: range === undefined ? {} : { range },
  })
  return { root, path, resolve, request }
}

describe('controlled media protocol', () => {
  it('streams task media with raw encoded paths and rechecks authorization before returning bytes', async () => {
    const f = await fixture(Buffer.from('0123456789'), '动画 #1 %20.mp4')
    const target = { conversationId: 'task', path: f.path }
    const url = taskFileMediaUrl(target)
    let revoked = false
    let resolutions = 0
    const runtime = {
      request: async (method: string, input: unknown) => {
        expect(method).toBe(taskFilesRpc.resolveMedia.method)
        expect(input).toEqual(target)
        if (revoked && ++resolutions === 2)
          throw new Error('DIRECTORY_NOT_AUTHORIZED')
        return f.resolve()
      },
    }
    const response = await handleMediaRequest(new Request(url, { headers: { range: 'bytes=2-5' } }), runtime)
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('2345')
    revoked = true
    const denied = await handleMediaRequest(new Request(url), runtime)
    expect(denied.status).toBe(404)
    expect(denied.body).toBeNull()
  })

  it.each([
    'lexora-file://task-media/?conversationId=task&path=/tmp/clip.mp4&path=/other.mp4',
    'lexora-file://task-media/clip.mp4?conversationId=task',
    'lexora-file://task-media/?conversationId=task&path=/tmp/clip.mp4&root=/tmp',
  ])('rejects ambiguous task media targets: %s', async (url) => {
    const f = await fixture()
    const response = await handleMediaRequest(new Request(url), { request: f.resolve })
    expect(response.status).toBe(400)
    expect(response.body).toBeNull()
  })

  it('streams SVG images with sandbox headers on the existing image endpoint', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="48"/>')
    const f = await fixture(bytes, 'preview.svg')
    const response = await handleMediaRequest(new Request('lexora-artifact://preview/image-id?v=1'), { request: f.resolve })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; sandbox')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })

  it('rejects non-image artifacts on the existing image endpoint', async () => {
    const f = await fixture()
    const response = await handleMediaRequest(new Request('lexora-artifact://preview/clip'), { request: f.resolve })
    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
  })

  it.each([
    [undefined, 200, '0123456789', null],
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=7-', 206, '789', 'bytes 7-9/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=7-999', 206, '789', 'bytes 7-9/10'],
  ])('streams the selected bytes for %s', async (range, status, body, contentRange) => {
    const f = await fixture()
    const response = await createMediaResponse(f.request(range), f.resolve)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(await response.text()).toBe(body)
  })

  it.each(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=9007199254740992-', 'bytes=-9007199254740992', 'bytes=0-9007199254740992'])('rejects invalid or unsatisfiable ranges: %s', async (range) => {
    const f = await fixture()
    const response = await createMediaResponse(f.request(range), f.resolve)
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(await response.text()).toBe('')
  })

  it('returns metadata for HEAD, including empty files, without a response body', async () => {
    const f = await fixture()
    const response = await createMediaResponse(f.request('bytes=999-', 'HEAD'), f.resolve)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.body).toBeNull()
    await writeFile(f.path, '')
    const empty = await createMediaResponse(f.request(), f.resolve)
    expect(empty.status).toBe(200)
    expect(empty.body).toBeNull()
    expect((await createMediaResponse(f.request('bytes=0-'), f.resolve)).status).toBe(416)
  })

  it('denies a revoked authorization between resolution and streaming without returning bytes', async () => {
    const f = await fixture()
    let count = 0
    const response = await createMediaResponse(f.request(), () => {
      if (++count === 2)
        throw new Error('DIRECTORY_NOT_AUTHORIZED')
      return f.resolve()
    })
    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
    await rm(f.path)
  })

  it('rejects file replacement and symlink escape after the authorization snapshot', async () => {
    const f = await fixture()
    const snapshot = await f.resolve()
    await rename(f.path, join(f.root, 'original.mp4'))
    await writeFile(f.path, 'substitute')
    expect((await createMediaResponse(f.request(), async () => snapshot)).status).toBe(404)
    await rm(f.path)
    const outside = await fixture(Buffer.from('private'))
    await symlink(outside.path, f.path)
    expect((await createMediaResponse(f.request(), async () => snapshot)).status).toBe(404)
  })

  it('rejects a same-size directory swap even when the original path identity is restored at ready', async () => {
    const f = await fixture()
    const name = 'clip.mp4'
    const original = join(f.root, 'original')
    const replacement = join(f.root, 'replacement')
    const parked = join(f.root, 'parked')
    await mkdir(original)
    await mkdir(replacement)
    await writeFile(join(original, name), Buffer.alloc(32 * 1024, 1))
    await writeFile(join(replacement, name), Buffer.alloc(32 * 1024, 2))
    const resolve = () => resolveMediaPreview(original, join(original, name))
    const snapshot = await resolve()
    let swapped = false
    const restore = async () => {
      if (!swapped)
        return
      await rename(original, replacement)
      await rename(parked, original)
      swapped = false
    }
    let resolutions = 0
    let restoredIdentity: string | undefined
    try {
      const response = await createMediaResponse(f.request(), async () => {
        if (++resolutions === 1) {
          const preview = await resolve()
          await rename(original, parked)
          await rename(replacement, original)
          swapped = true
          return preview
        }
        await restore()
        const current = await resolve()
        restoredIdentity = current.identity
        return current
      })
      let received = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          received = (await reader.read()).value?.byteLength ?? 0
        }
        finally { await reader.cancel().catch(() => undefined) }
      }
      if (restoredIdentity !== undefined)
        expect(restoredIdentity).toBe(snapshot.identity)
      expect(received).toBe(0)
      expect(response.status).toBe(404)
      expect(response.body).toBeNull()
    }
    finally { await restore() }
  })

  it('rejects missing, unsupported and non-regular files', async () => {
    const f = await fixture()
    await rm(f.path)
    expect((await createMediaResponse(f.request(), f.resolve)).status).toBe(404)
    await mkdir(f.path)
    expect((await createMediaResponse(f.request(), f.resolve)).status).toBe(404)
    const text = join(f.root, 'note.txt')
    await writeFile(text, 'not media')
    expect((await createMediaResponse(f.request(), () => resolveMediaPreview(f.root, text))).status).toBe(404)
    expect((await createMediaResponse(f.request(undefined, 'POST'), f.resolve)).status).toBe(405)
  })

  it('closes playback streams when the consumer cancels or the request aborts', async () => {
    const f = await fixture(Buffer.alloc(256 * 1024, 7))
    const response = await createMediaResponse(f.request(), f.resolve)
    const reader = response.body!.getReader()
    const chunk = (await reader.read()).value!
    expect(chunk.byteLength).toBeGreaterThan(0)
    await reader.cancel()
    expect((await reader.read()).done).toBe(true)
    const abort = new AbortController()
    const aborted = await createMediaResponse(f.request(undefined, 'GET', abort.signal), f.resolve)
    const abortedReader = aborted.body!.getReader()
    await abortedReader.read()
    abort.abort()
    await expect(abortedReader.read()).rejects.toThrow('MEDIA_REQUEST_ABORTED')
    await rm(f.path)
  })

  it.each(['lexora-file://skill-preview/?id=first&id=second&path=image.png', `lexora-artifact://preview/id?v=${'a'.repeat(32_768)}`])('rejects ambiguous or oversized image URLs as bad requests: %s', async (url) => {
    const f = await fixture(Buffer.from('image'), 'image.png')
    const response = await handleMediaRequest(new Request(url), { request: f.resolve })
    expect(response.status).toBe(400)
    expect(response.body).toBeNull()
  })

  it('rejects arbitrary path URLs before resolving a file', async () => {
    const runtime = {
      request: async () => {
        throw new Error('not authorized')
      },
    }
    for (const url of ['lexora-file://media/etc/passwd', 'lexora-file://media/?path=/etc/passwd', 'lexora-artifact://media/id?path=/etc/passwd']) {
      const response = await handleMediaRequest(new Request(url), runtime)
      expect([400, 404]).toContain(response.status)
    }
  })
})
