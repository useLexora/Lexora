import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { extensionResourceRange } from '../extensionResourceResponse'
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
  expect(extensionResourceRange(100, null)).toMatchObject({ start: 0, end: 99, status: 200 })
  expect(extensionResourceRange(100, 'bytes=50-')).toMatchObject({ start: 50, end: 99, status: 206 })
  expect(extensionResourceRange(100, 'bytes=-10')).toMatchObject({ start: 90, end: 99, status: 206 })
  expect(extensionResourceRange(100, 'bytes=90-999')).toMatchObject({ start: 90, end: 99, status: 206 })
  for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'invalid'])
    expect(extensionResourceRange(100, range)).toMatchObject({ status: 416, headers: { 'content-range': 'bytes */100' } })
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
