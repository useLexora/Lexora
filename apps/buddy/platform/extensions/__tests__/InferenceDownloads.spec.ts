import type { InferencePrepare, InferenceResourceProgress, InferenceResourceSet } from '../../../shared/extensions/extensionInference'
import type { InferenceResourceSource } from '../ExtensionInferenceResources'
import { createHash } from 'node:crypto'
import { link, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ExtensionInferenceResources } from '../ExtensionInferenceResources'
import { InferenceDownloads } from '../InferenceDownloads'

const linkHook = vi.hoisted(() => ({ after: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, link: async (...args: Parameters<typeof fs.link>) => {
    await fs.link(...args)
    await linkHook.after?.()
  } }
})

const owner = 'tests.resume'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const encode = (text: string) => new TextEncoder().encode(text)
function current() {}
function plan(): InferencePrepare {
  return { id: 'model', kind: 'model', files: [
    { path: 'model.bin', sha256: hash('weights'), size: 7, source: { url: 'https://fixture.invalid/model' } },
  ] }
}
const complete = () => new Response('weights', { headers: { 'content-length': '7', 'etag': '"v1"' } })
const resumed = () => new Response('ghts', { status: 206, headers: { 'content-range': 'bytes 3-6/7', 'content-length': '4', 'etag': '"v1"' } })
function source(response: InferenceResourceSource['response']): InferenceResourceSource {
  return {
    response,
    prepare: async () => {},
    openReference: async () => { throw new Error('Not a local import') },
  }
}

async function fixture() {
  const root = await createTemporaryDirectory('lexora-inference-resume-')
  const store = new ExtensionInferenceResources(root)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now += 250)
  const downloads = join(root, 'inference', owner, 'downloads')
  const prepare = (input: InferencePrepare, response: InferenceResourceSource['response'], report?: (value: InferenceResourceProgress) => void) => store.prepare(owner, input, source(response), new AbortController().signal, current, report)
  async function interrupt(input = plan(), ending: 'failure' | 'cancel' = 'failure') {
    const abort = new AbortController()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
        controller.enqueue(encode('wei'))
      },
    })
    await expect(store.prepare(owner, input, source(async () => new Response(body, { headers: { 'content-length': '7', 'etag': '"v1"' } })), abort.signal, current, (event) => {
      if (event.phase === 'download' && event.bytes === 3) {
        if (ending === 'cancel')
          abort.abort(new Error('TEST_CANCELLED'))
        else
          stream.error(new Error('connection reset'))
      }
    })).rejects.toThrow(ending === 'cancel' ? 'TEST_CANCELLED' : 'DOWNLOAD_FAILED')
    await store.drain()
  }
  async function partials(id = 'model') {
    const directory = InferenceDownloads.resourceDirectory(downloads, id)
    const entries = await readdir(directory, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return []
      throw error
    })
    return entries.filter(name => name.endsWith('.part')).map(name => join(directory, name))
  }
  async function contents(resource: InferenceResourceSet) {
    const lease = await store.acquire(owner, resource, source(async () => complete()), new AbortController().signal)
    try {
      return await lease.files[0]!.handle.readFile('utf8')
    }
    finally { await lease.release() }
  }
  return { root, store, prepare, interrupt, partials, contents }
}

it.each(['failure', 'cancel'] as const)('resumes actual persisted bytes after %s and host reopen with validated Range and If-Range', async (ending) => {
  const f = await fixture()
  await f.interrupt(plan(), ending)
  const [partial] = await f.partials()
  expect(await readFile(partial!, 'utf8')).toBe('wei')
  const events: InferenceResourceProgress[] = []
  const reopened = new ExtensionInferenceResources(f.root)
  const result = await reopened.prepare(owner, plan(), source(async (_from, _signal, headers) => {
    expect(headers).toEqual({ 'accept-encoding': 'identity', 'range': 'bytes=3-', 'if-range': '"v1"' })
    return resumed()
  }), new AbortController().signal, current, event => events.push(event))
  expect(events.find(event => event.phase === 'connect')).toMatchObject({ bytes: 3, resumedBytes: 3, totalBytes: 7 })
  expect(events.filter(event => event.phase === 'download').map(event => [event.bytes, event.resumedBytes])).toContainEqual([7, 3])
  expect(await f.contents(result)).toBe('weights')
  expect(await f.partials()).toEqual([])
  await reopened.drain()
})

it.each(['replaced path', 'modified prefix'] as const)('rejects a %s during the request instead of publishing stream-only checksums', async (change) => {
  const f = await fixture()
  const old = plan()
  old.files[0]!.sha256 = hash('olddata')
  const previous = await f.prepare(old, async () => new Response('olddata'))
  await f.interrupt()
  const [partial] = await f.partials()
  await expect(f.prepare(plan(), async () => {
    if (change === 'replaced path') {
      await rm(partial!)
      await writeFile(partial!, 'changed')
    }
    else {
      const writer = await open(partial!, 'r+')
      try {
        await writer.write(encode('xxx'), 0, 3, 0)
      }
      finally { await writer.close() }
    }
    return resumed()
  })).rejects.toThrow(/RESOURCE_FILE_CHANGED|CHECKSUM_MISMATCH/)
  expect(await f.store.list(owner)).toEqual([previous])
  expect(await f.contents(previous)).toBe('olddata')
  expect(await f.partials()).toEqual([])
  expect(await readdir(join(f.root, 'inference', owner, 'files'))).toEqual([hash('olddata')])
})

it.each([false, true])('preserves a concurrent same-hash local import after linking with inode replacement=%s', async (replace) => {
  const f = await fixture()
  let imported: InferenceResourceSet | undefined
  linkHook.after = async () => {
    linkHook.after = undefined
    const local: InferencePrepare = { ...plan(), id: 'local', files: [{ ...plan().files[0]!, source: { resourceId: '62d54d17-a1ad-4541-8bf5-103a7d6a496c', reference: false } }] }
    imported = await f.prepare(local, async () => complete())
    if (replace) {
      const replacement = join(f.root, 'replacement.bin')
      await writeFile(replacement, 'weights')
      await rename(replacement, join(f.root, 'inference', owner, 'files', hash('weights')))
    }
  }
  onTestFinished(() => {
    linkHook.after = undefined
  })
  if (replace) {
    await expect(f.prepare(plan(), async () => complete())).rejects.toThrow('RESOURCE_FILE_CHANGED')
    expect(await f.store.list(owner)).toEqual([imported])
  }
  else {
    const downloaded = await f.prepare(plan(), async () => complete())
    expect(await f.store.list(owner)).toEqual([imported, downloaded])
    expect(await f.contents(downloaded)).toBe('weights')
  }
  expect(imported).toBeDefined()
  expect(await f.contents(imported!)).toBe('weights')
  expect(await readdir(join(f.root, 'inference', owner, 'files'))).toEqual([hash('weights')])
})

it('never appends or truncates a partial hard-linked to an existing ready resource', async () => {
  const f = await fixture()
  await f.interrupt()
  const old: InferencePrepare = { id: 'old', kind: 'model', files: [{ path: 'old.bin', sha256: hash('old'), size: 3, source: { url: 'https://fixture.invalid/old' } }] }
  const previous = await f.prepare(old, async () => new Response('old'))
  const [partial] = await f.partials()
  await rm(partial!)
  await link(join(f.root, 'inference', owner, 'files', hash('old')), partial!)
  await expect(f.prepare(plan(), async () => complete())).rejects.toThrow('RESOURCE_CHANGED')
  expect(await f.contents(previous)).toBe('old')
  expect(await f.partials()).toEqual([])
})

it('uses on-disk size rather than checkpoint progress when a partial was truncated', async () => {
  const f = await fixture()
  await f.interrupt()
  await writeFile((await f.partials())[0]!, 'we')
  const result = await f.prepare(plan(), async (_from, _signal, headers) => {
    expect(headers?.range).toBe('bytes=2-')
    return new Response('ights', { status: 206, headers: { 'content-range': 'bytes 2-6/7', 'content-length': '5' } })
  })
  expect(await f.contents(result)).toBe('weights')
})

it('safely restarts and resets resumed progress when a server ignores Range with 200', async () => {
  const f = await fixture()
  await f.interrupt()
  const events: InferenceResourceProgress[] = []
  const result = await f.prepare(plan(), async (_from, _signal, headers) => {
    expect(headers?.range).toBe('bytes=3-')
    return complete()
  }, event => events.push(event))
  expect(events.filter(event => event.phase === 'download').every(event => event.resumedBytes === 0)).toBe(true)
  expect(events.find(event => event.phase === 'download')).toMatchObject({ bytes: 0 })
  expect(await f.contents(result)).toBe('weights')
})

it.each([
  ['wrong start', 'ghts', 206, { 'content-range': 'bytes 2-5/7', 'content-length': '4' }],
  ['wrong total', 'ghts', 206, { 'content-range': 'bytes 3-6/8', 'content-length': '4' }],
  ['wrong end', 'ght', 206, { 'content-range': 'bytes 3-5/7', 'content-length': '3' }],
  ['wrong length', 'ghts', 206, { 'content-range': 'bytes 3-6/7', 'content-length': '3' }],
  ['missing range', 'ghts', 206, { 'content-length': '4' }],
  ['changed etag', 'ghts', 206, { 'content-range': 'bytes 3-6/7', 'etag': '"v2"' }],
  ['weak etag', 'ghts', 206, { 'content-range': 'bytes 3-6/7', 'etag': 'W/"v1"' }],
  ['unsafe total', 'ghts', 206, { 'content-range': 'bytes 3-9007199254740991/9007199254740992' }],
  ['malformed length', 'ghts', 206, { 'content-range': 'bytes 3-6/7', 'content-length': 'four' }],
  ['unsatisfied range', '', 416, { 'content-range': 'bytes */7' }],
  ['encoded range', 'ghts', 206, { 'content-range': 'bytes 3-6/7', 'content-encoding': 'gzip' }],
  ['short body', 'ght', 206, { 'content-range': 'bytes 3-6/7', 'content-length': '4' }],
  ['long body', 'ghtss', 206, { 'content-range': 'bytes 3-6/7', 'content-length': '4' }],
  ['wrong hash', 'xxxx', 206, { 'content-range': 'bytes 3-6/7', 'content-length': '4' }],
] as const)('discards %s instead of publishing or reusing contaminated bytes', async (_name, body, status, headers) => {
  const f = await fixture()
  await f.interrupt()
  await expect(f.prepare(plan(), async () => new Response(body, { status, headers }))).rejects.toThrow(/EXTENSION_INFERENCE_(DOWNLOAD_RANGE_INVALID|CHECKSUM_MISMATCH|RESOURCE_LIMIT)/)
  expect(await f.store.list(owner)).toEqual([])
  expect(await f.partials()).toEqual([])
  const result = await f.prepare(plan(), async (_from, _signal, request) => {
    expect(request?.range).toBeUndefined()
    return complete()
  })
  expect(await f.contents(result)).toBe('weights')
})

it.each(['id', 'path', 'sha256', 'size', 'url'] as const)('isolates changed %s without trusting old task progress', async (field) => {
  const f = await fixture()
  await f.interrupt()
  const [original] = await f.partials()
  const changed = plan()
  if (field === 'id')
    changed.id = 'other'
  else if (field === 'path')
    changed.files[0]!.path = 'other.bin'
  else if (field === 'sha256')
    changed.files[0]!.sha256 = hash('changed')
  else if (field === 'size')
    changed.files[0]!.size = undefined
  else
    changed.files[0]!.source = { url: 'https://fixture.invalid/v2' }
  await expect(f.prepare(changed, async (_from, _signal, request) => {
    expect(request?.range).toBeUndefined()
    throw new Error('offline')
  })).rejects.toThrow('DOWNLOAD_FAILED')
  expect(await readFile(original!, 'utf8')).toBe('wei')
})

it('retains completed files of an uncommitted multi-file preparation without duplicating their bytes', async () => {
  const f = await fixture()
  const input = plan()
  input.files.push({ path: 'next.bin', sha256: hash('next'), size: 4, source: { url: 'https://fixture.invalid/next' } })
  await expect(f.prepare(input, async from => 'url' in from && from.url.endsWith('/next') ? Promise.reject(new Error('offline')) : complete())).rejects.toThrow('DOWNLOAD_FAILED')
  const events: InferenceResourceProgress[] = []
  const result = await f.prepare(input, async (from) => {
    expect('url' in from && from.url.endsWith('/next')).toBe(true)
    return new Response('next')
  }, event => events.push(event))
  expect(events.find(event => event.path === 'model.bin' && event.phase === 'download')).toMatchObject({ bytes: 7, resumedBytes: 7 })
  expect(result.files).toBe(2)
  expect(await f.contents(result)).toBe('weights')
  expect(await f.partials()).toEqual([])
  const files = join(f.root, 'inference', owner, 'files')
  const existing = await readdir(files)
  await f.prepare(plan(), async () => {
    throw new Error('must reuse verified content')
  })
  expect(await readdir(files)).toEqual(existing)
})

it('resumes preparation inputs while isolating changed preparation options and committing only completed output', async () => {
  const f = await fixture()
  const input: InferencePrepare = { id: 'model', kind: 'model', files: [], preparation: {
    inputs: [{ id: 'bundle', sha256: hash('weights'), size: 7, source: { url: 'https://fixture.invalid/bundle' } }],
    options: { version: 1 },
    maxBytes: 100,
    maxFiles: 2,
  } }
  await f.interrupt(input)
  const changed: InferencePrepare = { ...input, preparation: { ...input.preparation!, options: { version: 2 } } }
  await expect(f.prepare(changed, async (_from, _signal, headers) => {
    expect(headers?.range).toBeUndefined()
    throw new Error('offline')
  })).rejects.toThrow('DOWNLOAD_FAILED')
  const result = await f.store.prepare(owner, input, {
    ...source(async (_from, _signal, headers) => {
      expect(headers?.range).toBe('bytes=3-')
      return resumed()
    }),
    prepare: async (inputs, _options, signal, event) => {
      expect(await inputs[0]!.handle.readFile('utf8')).toBe('weights')
      await event({ type: 'file', path: 'model.bin', size: 7 }, new Uint8Array(), signal)
      await event({ type: 'chunk' }, encode('weights'), signal)
      await event({ type: 'end', sha256: hash('weights') }, new Uint8Array(), signal)
    },
  }, new AbortController().signal, current)
  expect(await f.contents(result)).toBe('weights')
  expect(await f.store.list(owner)).toEqual([result])
})

it('rejects unsolicited partial responses and oversized full responses before committing bytes', async () => {
  const f = await fixture()
  for (const response of [resumed(), new Response('weights!', { headers: { 'content-length': '8' } })]) {
    await expect(f.prepare(plan(), async () => response)).rejects.toThrow(/DOWNLOAD_RANGE_INVALID|CHECKSUM_MISMATCH/)
    expect(await f.partials()).toEqual([])
    expect(await f.store.list(owner)).toEqual([])
  }
})

it('removes only the named resource partials and refuses remove or prepare while it is active', async () => {
  const f = await fixture()
  await f.interrupt()
  const other = { ...plan(), id: 'other' }
  await f.interrupt(other)
  const abort = new AbortController()
  let checked = false
  await expect(f.store.prepare(owner, plan(), source(async () => {
    await expect(f.prepare(plan(), async () => complete())).rejects.toThrow('RESOURCE_BUSY')
    await expect(f.store.remove(owner, { id: 'model', revision: hash('pending') }, current)).rejects.toThrow('RESOURCE_BUSY')
    checked = true
    abort.abort(new Error('TEST_CANCELLED'))
    throw abort.signal.reason
  }), abort.signal, current)).rejects.toThrow('TEST_CANCELLED')
  expect(checked).toBe(true)
  await f.store.remove(owner, { id: 'model', revision: hash('pending') }, current)
  expect(await f.partials()).toEqual([])
  expect(await readFile((await f.partials('other'))[0]!, 'utf8')).toBe('wei')
  const restored = await f.prepare(other, async (_from, _signal, headers) => {
    expect(headers?.range).toBe('bytes=3-')
    return resumed()
  })
  expect(await f.contents(restored)).toBe('weights')
})
