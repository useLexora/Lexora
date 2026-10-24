import type { ExtensionLocalFile } from '../../../shared/extensions/extensionResources'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { EXTENSION_CREATED_FILE_LIMIT, EXTENSION_CREATED_STORAGE_LIMIT } from '../../../shared/extensions/extensionResources'
import { fileRange } from '../../filesystem/fileRange'
import { ExtensionResourceStore } from '../ExtensionResourceStore'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-extension-resource-'))
  roots.push(root)
  const path = join(root, 'selected.mp3')
  await writeFile(path, new Uint8Array(256 * 1024).map((_, index) => index % 251))
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const [resource] = await store.grant('tests.resources', [path], () => {})
  const lifetime = new AbortController()
  const request = (id = resource!.id, range?: string) => store.response('tests.resources', id, new Request('https://resource.invalid/file', { headers: range ? { range } : {} }), lifetime.signal)
  return { root, path, store, resource: resource!, lifetime, request }
}

it('persists only scoped handles publicly and supports real partial reads', async () => {
  const f = await fixture()
  expect(f.resource).toMatchObject({ name: 'selected.mp3', mimeType: 'audio/mpeg', size: 256 * 1024 })
  expect(JSON.stringify(f.resource)).not.toContain(f.root)
  const reopened = new ExtensionResourceStore(join(f.root, 'extensions'))
  expect(await reopened.list('tests.resources')).toEqual([f.resource])
  const part = await f.request(f.resource.id, 'bytes=100-199')
  expect(part.status).toBe(206)
  expect(part.headers.get('content-range')).toBe('bytes 100-199/262144')
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array((await readFile(f.path)).subarray(100, 200)))
  await expect(f.request(randomUUID())).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(reopened.response('tests.other', f.resource.id, new Request('https://resource.invalid'), f.lifetime.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it('rejects replacement and symlink retargeting without changing source files', async () => {
  const f = await fixture()
  const original = await readFile(f.path)
  await rename(f.path, `${f.path}.old`)
  await writeFile(f.path, original)
  await expect(f.request()).rejects.toThrow('EXTENSION_RESOURCE_CHANGED')
  await rm(f.path)
  await symlink(`${f.path}.old`, f.path)
  await expect(f.request()).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await readFile(`${f.path}.old`)).toEqual(original)
})

it('cancels streams and future access on revoke or expired view lifetime', async () => {
  const f = await fixture()
  const reader = (await f.request()).body!.getReader()
  await reader.read()
  await f.store.revoke('tests.resources', f.resource.id)
  await expect(reader.read()).rejects.toThrow('EXTENSION_RESOURCE_REVOKED')
  await expect(f.request()).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await f.store.list('tests.resources')).toEqual([])
  const [again] = await f.store.grant('tests.resources', [f.path], () => {})
  const next = (await f.request(again!.id)).body!.getReader()
  await next.read()
  f.lifetime.abort()
  await expect(next.read()).rejects.toThrow('EXTENSION_RESOURCE_REVOKED')
  expect((await readFile(f.path)).length).toBe(256 * 1024)
})

it('does not commit an expired selection and handles concurrent grants without losing records', async () => {
  const f = await fixture()
  const second = join(f.root, 'second.ogg')
  await writeFile(second, 'media bytes')
  await expect(f.store.grant('tests.resources', [second], () => {
    throw new Error('expired')
  })).rejects.toThrow('expired')
  expect(await f.store.list('tests.resources')).toEqual([f.resource])
  await Promise.all([f.store.grant('tests.resources', [second], () => {}), f.store.grant('tests.resources', [f.path], () => {})])
  expect((await f.store.list('tests.resources')).map(item => item.name).sort()).toEqual(['second.ogg', 'selected.mp3'])
})

it('bounds open, suffix, invalid and unsatisfiable byte ranges', () => {
  expect(fileRange(100, null)).toMatchObject({ start: 0, end: 99, status: 200 })
  expect(fileRange(100, 'bytes=50-')).toMatchObject({ start: 50, end: 99, status: 206 })
  expect(fileRange(100, 'bytes=-10')).toMatchObject({ start: 90, end: 99, status: 206 })
  expect(fileRange(100, 'bytes=90-999')).toMatchObject({ start: 90, end: 99, status: 206 })
  for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'invalid'])
    expect(fileRange(100, range)).toMatchObject({ status: 416, headers: { 'content-range': 'bytes */100' } })
})

it('applies plugin filters inside a directory, refreshes files and revokes the directory independently', async () => {
  const f = await fixture()
  const folder = join(f.root, 'library')
  await mkdir(join(folder, 'album'), { recursive: true })
  await writeFile(join(folder, 'album', 'song.mp3'), 'song bytes')
  await writeFile(join(folder, 'private.txt'), 'not media')
  await symlink(f.path, join(folder, 'escape.mp3'))
  await symlink(f.root, join(folder, 'loop'))
  const directory = await f.store.grantDirectory('tests.resources', folder, () => {})
  expect(Object.keys(directory).sort()).toEqual(['id', 'name'])
  const [song] = await f.store.scanDirectory('tests.resources', { id: directory.id, extensions: ['mp3', 'wav'], recursive: true }, () => {})
  expect(song?.name).toBe('song.mp3')
  expect(await f.store.scanDirectory('tests.resources', { id: directory.id, extensions: ['mp3', 'wav'], recursive: true }, () => {})).toEqual([song])
  await writeFile(join(folder, 'new.wav'), 'new media')
  await rm(join(folder, 'album', 'song.mp3'))
  const [added] = await f.store.scanDirectory('tests.resources', { id: directory.id, extensions: ['mp3', 'wav'], recursive: true }, () => {})
  expect(added?.name).toBe('new.wav')
  expect(await f.store.list('tests.resources')).toEqual([f.resource, added])
  const restored = new ExtensionResourceStore(join(f.root, 'extensions'))
  expect(await restored.directories('tests.resources')).toEqual([directory])
  await restored.revokeDirectory('tests.resources', directory.id, () => {})
  await expect(f.request(added!.id)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await restored.list('tests.resources')).toEqual([f.resource])
  expect(await readFile(join(folder, 'new.wav'), 'utf8')).toBe('new media')
})

it('rejects replaced directory roots and stale authorization during scanning', async () => {
  const f = await fixture()
  const folder = join(f.root, 'library')
  await mkdir(folder)
  await writeFile(join(folder, 'song.mp3'), 'song')
  const directory = await f.store.grantDirectory('tests.resources', folder, () => {})
  await expect(f.store.scanDirectory('tests.resources', { id: directory.id, extensions: ['mp3', 'wav'], recursive: true }, () => {
    throw new Error('expired')
  })).rejects.toThrow('expired')
  expect(await f.store.list('tests.resources')).toEqual([f.resource])
  await rename(folder, `${folder}-old`)
  await mkdir(folder)
  await expect(f.store.scanDirectory('tests.resources', { id: directory.id, extensions: ['mp3', 'wav'], recursive: true }, () => {})).rejects.toThrow('EXTENSION_RESOURCE_DIRECTORY_CHANGED')
})

it('reads arbitrary formats as text or bounded bytes without a host format whitelist', async () => {
  const f = await fixture()
  const novel = join(f.root, 'novel.txt')
  const design = join(f.root, 'shape.vendorcad')
  const empty = join(f.root, 'empty')
  await writeFile(novel, '第一章\n海风吹过窗台。')
  await writeFile(design, new Uint8Array([0, 255, 7, 100, 42]))
  await writeFile(empty, '')
  const [text, cad, blank] = await f.store.grant('tests.resources', [novel, design, empty], () => {})
  expect(await f.store.readText('tests.resources', text!.id, f.lifetime.signal)).toBe('第一章\n海风吹过窗台。')
  expect(cad!.mimeType).toBe('application/octet-stream')
  const part = await f.store.readBytes('tests.resources', cad!.id, 1, 3, f.lifetime.signal)
  expect(part).toMatchObject({ size: 5, eof: false })
  expect([...Buffer.from(part.base64, 'base64')]).toEqual([255, 7, 100])
  expect(await f.store.readBytes('tests.resources', cad!.id, 4, 10, f.lifetime.signal)).toMatchObject({ base64: 'Kg==', eof: true })
  expect(await f.store.readBytes('tests.resources', cad!.id, 5, 10, f.lifetime.signal)).toMatchObject({ base64: '', eof: true })
  expect(await f.store.readText('tests.resources', blank!.id, f.lifetime.signal)).toBe('')
})

it('keeps independent directory scopes and other scan filters while refreshing one subset', async () => {
  const f = await fixture()
  const folder = join(f.root, 'project')
  await mkdir(join(folder, 'nested'), { recursive: true })
  const text = join(folder, 'chapter.txt')
  await writeFile(text, 'chapter')
  await writeFile(join(folder, 'nested', 'image.png'), 'image')
  const dir = await f.store.grantDirectory('tests.resources', folder, () => {})
  const files = await f.store.scanDirectory('tests.resources', { id: dir.id, extensions: [], recursive: true }, () => {})
  expect(files.map(file => file.relativePath).sort()).toEqual(['chapter.txt', 'nested/image.png'])
  const [selected] = await f.store.grant('tests.resources', [text], () => {})
  expect(selected!.id).not.toBe(files.find(file => file.name === 'chapter.txt')!.id)
  await f.store.scanDirectory('tests.resources', { id: dir.id, extensions: ['txt'], recursive: false }, () => {})
  expect(await f.store.list('tests.resources')).toHaveLength(4)
  await f.store.revokeDirectory('tests.resources', dir.id, () => {})
  expect(await f.store.list('tests.resources')).toEqual([f.resource, selected])
  expect(await f.store.readText('tests.resources', selected!.id, f.lifetime.signal)).toBe('chapter')
})

it('reads sparse media beyond 2 GiB without buffering the file', async () => {
  const f = await fixture()
  const path = join(f.root, 'large.mp4')
  const file = await open(path, 'w')
  const offset = 3 * 1024 ** 3
  try {
    if (process.platform === 'win32')
      await promisify(execFile)('fsutil.exe', ['sparse', 'setflag', path], { windowsHide: true, timeout: 5000 })
    await file.truncate(offset + 4)
    await file.write(Buffer.from('tail'), 0, 4, offset)
  }
  finally {
    await file.close()
  }
  const [resource] = await f.store.grant('tests.resources', [path], () => {})
  expect(resource!.size).toBe(offset + 4)
  const result = await f.store.readBytes('tests.resources', resource!.id, offset, 4, f.lifetime.signal)
  expect(result).toEqual({ base64: Buffer.from('tail').toString('base64'), size: offset + 4, eof: true })
})

it('owns downloaded files independently from local grants and releases shared content only after its last handle', async () => {
  const f = await fixture()
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42)
  const first = await f.store.import('tests.resources', 'download.bin', 'application/octet-stream', new Response(bytes), f.lifetime.signal, () => {})
  const second = await f.store.import('tests.resources', 'copy.bin', 'application/octet-stream', new Response(bytes), f.lifetime.signal, () => {})
  const restored = new ExtensionResourceStore(join(f.root, 'extensions'))
  expect(await restored.list('tests.resources', false)).toEqual([first, second])
  await expect(restored.response('tests.resources', f.resource.id, new Request('https://resource.invalid/'), f.lifetime.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(restored.response('tests.other', first.id, new Request('https://resource.invalid/'), f.lifetime.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await restored.release('tests.resources', first.id, () => {})
  expect(await restored.readBytes('tests.resources', second.id, second.size - 3, 3, f.lifetime.signal, false)).toEqual({ base64: 'Kioq', size: bytes.length, eof: true })
  await restored.revoke('tests.resources')
  expect(await restored.list('tests.resources', false)).toEqual([second])
  await restored.release('tests.resources', second.id, () => {})
  expect(await readdir(join(f.root, 'extensions', 'data', 'tests.resources', 'files'))).toEqual([])
  expect(await readFile(f.path)).toHaveLength(256 * 1024)
})

it('cancels a parallel import without waiting for another download or retaining partial bytes', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const other = new AbortController()
  const held = f.store.import('tests.resources', 'held.bin', 'application/octet-stream', new Response(new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(new Uint8Array(64 * 1024))
  } })), other.signal, () => {})
  const heldRejected = expect(held).rejects.toThrow()
  const started = deferred<void>()
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(64 * 1024))
    },
    pull() { started.resolve() },
  }))
  const pending = f.store.import('tests.resources', 'cancelled.bin', 'application/octet-stream', response, controller.signal, () => {})
  const rejected = expect(pending).rejects.toThrow()
  await started.promise
  controller.abort()
  await rejected
  other.abort()
  await heldRejected
  expect(await f.store.list('tests.resources', false)).toEqual([])
  expect(await readdir(join(f.root, 'extensions', 'data', 'tests.resources', 'files'))).toEqual([])
})

it('publishes only complete private files and retains copy chains across restarts until the last handle is released', async () => {
  const f = await fixture()
  const id = 'tests.generated'
  const bytes = Buffer.alloc(190 * 1024).map((_, index) => index % 251)
  const upload = await f.store.create(id, { name: 'draft.xlsx', mimeType: 'application/octet-stream', size: bytes.length }, f.lifetime.signal, () => {})
  await upload.append(0, Buffer.from(bytes.subarray(0, 96 * 1024)).toString('base64'))
  expect(await f.store.list(id, false)).toEqual([])
  await expect(upload.commit()).rejects.toThrow('EXTENSION_RESOURCE_WRITE_INCOMPLETE')
  await upload.append(96 * 1024, Buffer.from(bytes.subarray(96 * 1024)).toString('base64'))
  const file = await upload.commit()
  expect(file).toEqual({ id: expect.any(String), name: 'draft.xlsx', mimeType: 'application/octet-stream', size: bytes.length })
  const reopened = new ExtensionResourceStore(join(f.root, 'extensions'))
  expect(await reopened.list(id, false)).toEqual([file])
  const response = await reopened.response(id, file.id, new Request('https://resource.invalid'), f.lifetime.signal, false)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  await expect(reopened.response('tests.foreign', file.id, new Request('https://resource.invalid'), f.lifetime.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  const copy = await reopened.copy(id, file.id, undefined, () => {})
  expect(copy).toEqual({ ...file, id: expect.any(String) })
  expect(copy!.id).not.toBe(file.id)
  await reopened.release(id, file.id, () => {})
  const restored = new ExtensionResourceStore(join(f.root, 'extensions'))
  const next = await restored.copy(id, copy!.id, 'next.xlsx', () => {})
  await restored.release(id, copy!.id, () => {})
  const retained = await restored.response(id, next!.id, new Request('https://resource.invalid'), f.lifetime.signal, false)
  expect(Buffer.from(await retained.arrayBuffer())).toEqual(bytes)
  expect(await readdir(join(f.root, 'extensions', 'data', id, 'files'))).toHaveLength(1)
  await restored.release(id, next!.id, () => {})
  expect(await restored.list(id, false)).toEqual([])
  expect(await readdir(join(f.root, 'extensions', 'data', id, 'files'))).toEqual([])
  const empty = await f.store.create(id, { name: 'empty.txt', mimeType: 'text/plain', size: 0 }, f.lifetime.signal, () => {})
  const emptyFile = await empty.commit()
  expect(await restored.readText(id, emptyFile.id, f.lifetime.signal, false)).toBe('')
})

it('charges copied generated bytes and pending uploads together without retroactively limiting external imports', async () => {
  const f = await fixture()
  const id = 'tests.generated'
  const bytes = Buffer.alloc(1024 * 1024, 42)
  const input = { name: 'draft.bin', mimeType: 'application/octet-stream', size: bytes.length }
  const upload = await f.store.create(id, input, f.lifetime.signal, () => {})
  for (let offset = 0; offset < bytes.length; offset += 96 * 1024)
    await upload.append(offset, bytes.subarray(offset, offset + 96 * 1024).toString('base64'))
  const file = await upload.commit()
  const path = join(f.root, 'extensions', 'data', id, 'owned-resources.json')
  const [original] = JSON.parse(await readFile(path, 'utf8')) as Array<{ resource: ExtensionLocalFile, key: string, generated?: true }>
  const count = EXTENSION_CREATED_STORAGE_LIMIT / bytes.length - 1
  await writeFile(path, JSON.stringify(Array.from({ length: count }, (_, index) => index ? { ...original, resource: { ...file, id: randomUUID() } } : original)))
  const pending = await f.store.create(id, input, f.lifetime.signal, () => {})
  await expect(f.store.copy(id, file.id, undefined, () => {})).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  await pending.dispose()
  const results = await Promise.allSettled([
    f.store.copy(id, file.id, 'copy.bin', () => {}),
    f.store.copy(id, file.id, 'overflow.bin', () => {}),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: new Error('EXTENSION_RESOURCE_STORAGE_LIMIT') })
  await expect(f.store.create(id, { ...input, size: 1 }, f.lifetime.signal, () => {})).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  const external = await f.store.import(id, 'external.bin', input.mimeType, new Response('external'), f.lifetime.signal, () => {})
  const externalCopy = await f.store.copy(id, external.id, undefined, () => {})
  expect(externalCopy).toMatchObject({ name: 'external.bin', size: 8 })
  expect(await f.store.readText(id, externalCopy!.id, f.lifetime.signal, false)).toBe('external')
  await f.store.release(id, file.id, () => {})
  const reopened = new ExtensionResourceStore(join(f.root, 'extensions'))
  const copied = (await reopened.list(id, false)).find(resource => resource.name === 'copy.bin')!
  expect(await reopened.copy(id, copied.id, undefined, () => {})).toMatchObject({ size: bytes.length })
  await expect(reopened.copy(id, copied.id, undefined, () => {})).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
})

it('shares generated upload admission with copies and rejects expired copies without changing the registry', async () => {
  const f = await fixture()
  const id = 'tests.generated'
  const input = { name: 'draft.bin', mimeType: 'application/octet-stream', size: 0 }
  const file = await (await f.store.create(id, input, f.lifetime.signal, () => {})).commit()
  const pending = await Promise.all([
    f.store.create(id, input, f.lifetime.signal, () => {}),
    f.store.create(id, input, f.lifetime.signal, () => {}),
  ])
  await expect(f.store.copy(id, file.id, undefined, () => {})).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  await Promise.all(pending.map(upload => upload.dispose()))
  await expect(f.store.copy(id, file.id, undefined, () => {
    throw new Error('expired')
  })).rejects.toThrow('expired')
  expect(await f.store.list(id, false)).toEqual([file])
  await f.store.release(id, file.id, () => {})
  expect(await f.store.copy(id, file.id, undefined, () => {})).toBeNull()
  expect(await f.store.list(id, false)).toEqual([])
})

it('bounds generated uploads and removes incomplete, cancelled and expired bytes', async () => {
  const f = await fixture()
  const id = 'tests.generated'
  const input = { name: 'draft.bin', mimeType: 'application/octet-stream', size: 8 }
  await expect(f.store.create(id, { ...input, size: EXTENSION_CREATED_FILE_LIMIT + 1 }, f.lifetime.signal, () => {})).rejects.toThrow()
  const first = await f.store.create(id, input, f.lifetime.signal, () => {})
  const second = await f.store.create(id, input, f.lifetime.signal, () => {})
  await expect(f.store.create(id, input, f.lifetime.signal, () => {})).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  await expect(first.append(1, 'YQ==')).rejects.toThrow('EXTENSION_RESOURCE_WRITE_RANGE')
  await expect(first.append(0, Buffer.alloc(9).toString('base64'))).rejects.toThrow('EXTENSION_RESOURCE_WRITE_RANGE')
  await first.append(0, Buffer.from('partial').toString('base64'))
  await first.dispose()
  await expect(first.commit()).rejects.toThrow('EXTENSION_RESOURCE_WRITE_EXPIRED')
  f.lifetime.abort()
  await second.dispose()
  expect(await f.store.list(id, false)).toEqual([])
  const files = await readdir(join(f.root, 'extensions', 'data', id, 'files'))
  expect(files).toEqual([])
  let current = true
  const guard = () => {
    if (!current)
      throw new Error('expired')
  }
  const third = await f.store.create(id, input, new AbortController().signal, guard)
  await third.append(0, Buffer.from('complete').toString('base64'))
  current = false
  await expect(third.commit()).rejects.toThrow('expired')
  await third.dispose()
  expect(await f.store.list(id, false)).toEqual([])
})
