import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeFileEngine } from '../../files/NativeFileEngine'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SpaceFileService } from '../SpaceFileService'
import { SpaceService } from '../SpaceService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-file-view-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanup.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const repository = createSpaceRepository(database)
  const spaces = new SpaceService(repository)
  const space = await spaces.create({ name: 'Files', memoryScope: 'space_only', primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true })
  const engine = new NativeFileEngine(join(root, 'operations'))
  await engine.ready()
  const files = new SpaceFileService(repository, engine)
  cleanup.push(async () => {
    await files.dispose()
    await engine.dispose()
  })
  const target = { spaceId: space.id, directoryId: space.primaryDirectory!.id, revision: space.primaryDirectory!.revision, path: '' }
  return { database, root, workspace, files, spaces, target }
}

describe('space file browsing', () => {
  it('returns refreshable image URLs, enforces 8 MiB at both metadata and byte access, and rejects revoked access', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'preview.png')
    await writeFile(path, Uint8Array.of(137, 80, 78, 71))
    const input = { ...f.target, path: 'preview.png' }
    const first = await f.files.read(input)
    const second = await f.files.read(input)
    expect(first).toMatchObject({ kind: 'image', sizeBytes: 4, text: null, imageUrl: expect.stringMatching(/^lexora-file:\/\/media\//) })
    expect(JSON.stringify(first).length).toBeLessThan(1024)
    expect(second.imageUrl).not.toBe(first.imageUrl)
    expect(new URL(first.imageUrl!).searchParams.get('path')).toBe('preview.png')
    expect(await f.files.resolveMedia(input)).toMatchObject({ path, mimeType: 'image/png', sizeBytes: 4 })
    await rm(path)
    await expect(f.files.read(input)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await writeFile(path, Uint8Array.of(137, 80, 78, 71))
    expect(await f.files.read(input)).toEqual({ ...first, imageUrl: expect.stringMatching(/^lexora-file:/) })
    await truncate(path, 8 * 1024 * 1024)
    const large = await f.files.read(input)
    expect(large.kind).toBe('image')
    expect(JSON.stringify(large).length).toBeLessThan(1024)
    expect((await f.files.resolveMedia(input)).sizeBytes).toBe(8 * 1024 * 1024)
    await truncate(path, 8 * 1024 * 1024 + 1)
    expect(await f.files.read(input)).toMatchObject({ kind: 'oversized', imageUrl: null, text: null })
    await expect(f.files.resolveMedia(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await f.spaces.update({ spaceId: f.target.spaceId, name: 'Files', memoryScope: 'space_only', primaryDirectory: null, primaryDirectorySelectionVerified: false })
    await expect(f.files.read(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(f.files.resolveMedia(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('returns a media URL without loading large bytes and rejects stale directory revisions', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'large clip.mp4')
    await writeFile(path, '')
    await truncate(path, 1024 * 1024 * 1024)
    const target = { ...f.target, path: 'large clip.mp4' }
    const preview = await f.files.read(target)
    expect(preview).toMatchObject({ kind: 'video', sizeBytes: 1024 * 1024 * 1024, text: null, imageUrl: null })
    const url = new URL(preview.mediaUrl!)
    expect(url.protocol).toBe('lexora-file:')
    expect(url.hostname).toBe('media')
    expect(url.searchParams.get('path')).toBe(target.path)
    expect(url.searchParams.get('directoryId')).toBe(target.directoryId)
    expect(await f.files.resolveMedia(target)).toMatchObject({ path, root: f.workspace, mimeType: 'video/mp4', sizeBytes: preview.sizeBytes })
    f.database.prepare('UPDATE space_directory_bindings SET revision = revision + 1 WHERE id = ?').run(target.directoryId)
    await expect(f.files.resolveMedia(target)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('rejects media symlink escapes, protected targets, missing files and unsupported formats', async () => {
    const f = await fixture()
    const outside = join(f.root, 'private.mp3')
    await writeFile(outside, 'private')
    await symlink(outside, join(f.workspace, 'escape.mp3'))
    await expect(f.files.resolveMedia({ ...f.target, path: 'escape.mp3' })).rejects.toThrow()
    await expect(f.files.resolveMedia({ ...f.target, path: 'missing.mp3' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await writeFile(join(f.workspace, 'notes.txt'), 'text')
    await expect(f.files.resolveMedia({ ...f.target, path: 'notes.txt' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const secret = join(f.workspace, 'protected.mp3')
    await writeFile(secret, 'private')
    vi.stubEnv('LEXORA_BUDDY_STORAGE_PROTECTION', JSON.stringify([secret]))
    await expect(f.files.resolveMedia({ ...f.target, path: 'protected.mp3' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('browses, edits and copies additional files, then denies stale access after removal without deleting data', async () => {
    const f = await fixture()
    const extra = join(f.root, 'extra')
    await mkdir(extra)
    await writeFile(join(extra, 'note.txt'), 'original')
    const before = f.spaces.list()[0]!
    const configuration = { spaceId: before.id, name: before.name, memoryScope: before.memoryScope, primaryDirectory: { id: before.primaryDirectory!.id, root: before.primaryDirectory!.root }, primaryDirectorySelectionVerified: false }
    const space = await f.spaces.update({ ...configuration, additionalDirectoryChanges: { add: [extra], remove: [] }, additionalDirectorySelectionsVerified: true })
    const binding = space.additionalDirectories[0]!
    const target = { spaceId: space.id, directoryId: binding.id, revision: binding.revision, path: 'note.txt' }
    expect((await f.files.list({ ...target, path: '' })).entries).toMatchObject([{ name: 'note.txt' }])
    expect(await f.files.read(target)).toMatchObject({ kind: 'text', text: 'original' })
    const document = await f.files.readDocument(target)
    const saved = await f.files.saveDocument({ ...target, operationId: randomUUID(), etag: document.etag, text: 'edited' })
    expect(saved.status).toBe('saved')
    await f.files.mutate({ ...target, operationId: randomUUID(), action: { kind: 'copy', destination: { ...f.target, path: 'copied.txt' } } })
    expect(await readFile(join(f.workspace, 'copied.txt'), 'utf8')).toBe('edited')
    await f.spaces.update({ ...configuration, additionalDirectoryChanges: { add: [], remove: [binding.id] } })
    await expect(f.files.list({ ...target, path: '' })).rejects.toThrow()
    await expect(f.files.read(target)).rejects.toThrow()
    await expect(f.files.saveDocument({ ...target, operationId: randomUUID(), etag: saved.document.etag, text: 'revoked' })).rejects.toThrow()
    expect(await readFile(join(extra, 'note.txt'), 'utf8')).toBe('edited')
    expect(await f.files.read({ ...f.target, path: 'copied.txt' })).toMatchObject({ text: 'edited' })
  })

  it('does not follow a replaced binding or expose sensitive descendants through an additional directory', async () => {
    const f = await fixture()
    const extra = join(f.root, 'extra')
    const replacement = join(f.root, 'replacement')
    const alias = join(f.root, 'alias')
    await mkdir(extra)
    await mkdir(replacement)
    await symlink(extra, alias, 'junction')
    const before = f.spaces.list()[0]!
    const updated = await f.spaces.update({ spaceId: before.id, name: before.name, memoryScope: before.memoryScope, primaryDirectory: { id: before.primaryDirectory!.id, root: before.primaryDirectory!.root }, primaryDirectorySelectionVerified: false, additionalDirectoryChanges: { add: [alias], remove: [] }, additionalDirectorySelectionsVerified: true })
    const binding = updated.additionalDirectories[0]!
    const target = { spaceId: before.id, directoryId: binding.id, revision: binding.revision, path: '' }
    const secret = join(extra, 'secret')
    await mkdir(secret)
    await writeFile(join(secret, 'credentials'), 'private')
    vi.stubEnv('LEXORA_BUDDY_STORAGE_PROTECTION', JSON.stringify([secret]))
    expect((await f.files.list(target)).entries).toEqual([])
    await expect(f.files.readDocument({ ...target, path: 'secret/credentials' })).rejects.toThrow()
    await expect(f.files.mutate({ ...target, path: 'secret/new.txt', operationId: randomUUID(), action: { kind: 'createFile' } })).rejects.toThrow()
    await rm(alias)
    await symlink(replacement, alias, 'junction')
    await expect(f.files.list(target)).rejects.toThrow()
    await expect(f.files.locate(target)).rejects.toThrow()
    expect(await readFile(join(secret, 'credentials'), 'utf8')).toBe('private')
  })

  it('reports a committed write before denying its response after authorization is revoked', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'private-name.md')
    await writeFile(path, 'before')
    const target = { ...f.target, path: 'private-name.md' }
    const original = await f.files.readDocument(target)
    const events: unknown[] = []
    f.files.onDidChange((event) => {
      events.push(event)
      if (event.kind === 'saved')
        f.database.prepare('UPDATE space_directory_bindings SET revision = revision + 1 WHERE id = ?').run(target.directoryId)
    })
    await expect(f.files.saveDocument({ operationId: randomUUID(), ...target, etag: original.etag, text: 'private changed content' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await readFile(path, 'utf8')).toBe('private changed content')
    expect(events.filter(event => (event as { kind: string }).kind !== 'changed')).toMatchObject([{ kind: 'saved' }, { kind: 'response-denied' }])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain(original.etag)
  })

  it('lists directories lazily with complete pagination and previews bounded file types', async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, 'src'))
    await Promise.all(Array.from({ length: 251 }, (_, index) => writeFile(join(f.workspace, `file-${String(index).padStart(3, '0')}.ts`), 'export const value = 1\n')))
    const first = await f.files.list(f.target)
    expect(first.nextCursor).not.toBeNull()
    expect(first.entries[0]).toMatchObject({ name: 'src', kind: 'directory' })
    const last = await f.files.list({ ...f.target, cursor: first.nextCursor! })
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.entries, ...last.entries].map(entry => entry.path)).size).toBe(252)
    expect(await f.files.read({ ...f.target, path: 'file-001.ts' })).toMatchObject({ kind: 'text', text: 'export const value = 1\n' })
    await writeFile(join(f.workspace, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    expect(await f.files.read({ ...f.target, path: 'binary.dat' })).toMatchObject({ kind: 'binary', text: null })
    await writeFile(join(f.workspace, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    expect(await f.files.read({ ...f.target, path: 'large.txt' })).toMatchObject({ kind: 'oversized', text: null })
  })

  it('reports deleted text through preview and editing and reads its restored content', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'note.md')
    const target = { ...f.target, path: 'note.md' }
    await writeFile(path, '# original\n')
    const original = await f.files.read(target)
    expect(await f.files.readDocument(target)).toMatchObject({ text: '# original\n' })
    await rm(path)
    await expect(f.files.read(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(f.files.readDocument(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await writeFile(path, '# restored\n')
    expect(await f.files.read(target)).toEqual({ ...original, text: '# restored\n' })
    expect(await f.files.readDocument(target)).toMatchObject({ text: '# restored\n' })
  })

  it('reports a missing target when its former parent is now a regular file', async () => {
    const f = await fixture()
    const directory = join(f.workspace, 'reports')
    await mkdir(directory)
    await writeFile(join(directory, 'note.md'), '# note\n')
    await rm(directory, { recursive: true })
    await writeFile(directory, 'not a directory')
    const target = { ...f.target, path: 'reports/note.md' }
    await expect(f.files.read(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(f.files.readDocument(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('keeps an unavailable directory distinct from a missing file', async () => {
    const f = await fixture()
    await rm(f.workspace, { recursive: true })
    const target = { ...f.target, path: 'note.md' }
    await expect(f.files.read(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.files.readDocument(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves reader failures instead of reporting an existing file as missing', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'note.md')
    await writeFile(path, '# retained\n')
    vi.stubEnv('LEXORA_BUDDY_FILE_READER', join(f.root, 'missing-reader'))
    await expect(f.files.read({ ...f.target, path: 'note.md' })).rejects.toMatchObject({ code: 'BOUNDED_FILE_READER_UNAVAILABLE' })
    expect(await readFile(path, 'utf8')).toBe('# retained\n')
  })

  it('saves UTF-8 content without changing its BOM, rejects stale etags and rechecks grants', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'note.md')
    await writeFile(path, '\uFEFFbase\r\n')
    const target = { ...f.target, path: 'note.md' }
    const original = await f.files.readDocument(target)
    expect(original.text).toBe('\uFEFFbase\r\n')
    const saved = await f.files.saveDocument({ operationId: randomUUID(), ...target, etag: original.etag, text: '\uFEFFchanged\r\n' })
    expect(saved.status).toBe('saved')
    expect(await readFile(path, 'utf8')).toBe('\uFEFFchanged\r\n')
    const conflict = await f.files.saveDocument({ operationId: randomUUID(), ...target, etag: original.etag, text: 'stale overwrite' })
    expect(conflict).toMatchObject({ status: 'conflict', document: { text: '\uFEFFchanged\r\n' } })
    await expect(f.files.saveDocument({ operationId: randomUUID(), ...target, revision: 99, etag: saved.document.etag, text: 'wrong grant' })).rejects.toThrow()
    await f.spaces.delete(target.spaceId)
    await expect(f.files.saveDocument({ operationId: randomUUID(), ...target, etag: saved.document.etag, text: 'revoked grant' })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('\uFEFFchanged\r\n')
  })

  it('rejects escape paths and stale directory bindings without reading outside the workspace', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'outside.txt'), 'outside')
    await writeFile(join(f.workspace, 'inside.txt'), 'inside')
    await symlink(join(f.root, 'outside.txt'), join(f.workspace, 'escape'))
    expect((await f.files.list(f.target)).entries.find(entry => entry.name === 'escape')).toMatchObject({ unavailable: true })
    for (const path of ['../outside.txt', join(f.root, 'outside.txt'), 'escape'])
      await expect(f.files.read({ ...f.target, path })).rejects.toThrow()
    await expect(f.files.read({ ...f.target, path: 'inside.txt', revision: 99 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(f.files.readDocument({ ...f.target, path: 'inside.txt', revision: 99 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await f.spaces.delete(f.target.spaceId)
    await expect(f.files.list(f.target)).rejects.toThrow()
    await expect(f.files.read({ ...f.target, path: 'inside.txt' })).rejects.toThrow()
    await expect(f.files.locate({ ...f.target, path: 'inside.txt' })).rejects.toThrow()
  })
})
