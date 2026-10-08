import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SpaceFileService } from '../SpaceFileService'
import { SpaceService } from '../SpaceService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
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
  const files = new SpaceFileService(repository)
  const target = { spaceId: space.id, directoryId: space.primaryDirectory!.id, revision: space.primaryDirectory!.revision, path: '' }
  return { database, root, workspace, files, spaces, target }
}

describe('space file browsing', () => {
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
    await expect(f.files.saveDocument({ ...target, etag: original.etag, text: 'private changed content' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await readFile(path, 'utf8')).toBe('private changed content')
    expect(events).toMatchObject([{ kind: 'saved', revision: 1 }, { kind: 'response-denied', revision: 2 }])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain(original.etag)
  })

  it('lists directories lazily with complete pagination and previews bounded file types', async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, 'src'))
    await Promise.all(Array.from({ length: 251 }, (_, index) => writeFile(join(f.workspace, `file-${String(index).padStart(3, '0')}.ts`), 'export const value = 1\n')))
    const first = await f.files.list(f.target)
    expect(first.entries).toHaveLength(250)
    expect(first.entries[0]).toMatchObject({ name: 'src', kind: 'directory' })
    const last = await f.files.list({ ...f.target, cursor: first.nextCursor! })
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.entries, ...last.entries].map(entry => entry.path)).size).toBe(252)
    expect(await f.files.read({ ...f.target, path: 'file-001.ts' })).toMatchObject({ kind: 'text', text: 'export const value = 1\n' })
    await writeFile(join(f.workspace, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    expect(await f.files.read({ ...f.target, path: 'binary.dat' })).toMatchObject({ kind: 'binary', text: null })
    await writeFile(join(f.workspace, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    expect(await f.files.read({ ...f.target, path: 'large.txt' })).toMatchObject({ kind: 'oversized', text: null })
    expect(await f.files.locate({ ...f.target, path: 'file-001.ts' })).toEqual({ path: join(f.workspace, 'file-001.ts'), kind: 'file' })
  })

  it('saves UTF-8 content without changing its BOM, rejects stale etags and rechecks grants', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'note.md')
    await writeFile(path, '\uFEFFbase\r\n')
    const target = { ...f.target, path: 'note.md' }
    const original = await f.files.readDocument(target)
    expect(original.text).toBe('\uFEFFbase\r\n')
    const saved = await f.files.saveDocument({ ...target, etag: original.etag, text: '\uFEFFchanged\r\n' })
    expect(saved.status).toBe('saved')
    expect(await readFile(path, 'utf8')).toBe('\uFEFFchanged\r\n')
    const conflict = await f.files.saveDocument({ ...target, etag: original.etag, text: 'stale overwrite' })
    expect(conflict).toMatchObject({ status: 'conflict', document: { text: '\uFEFFchanged\r\n' } })
    await expect(f.files.saveDocument({ ...target, revision: 99, etag: saved.document.etag, text: 'wrong grant' })).rejects.toThrow()
    await f.spaces.delete(target.spaceId)
    await expect(f.files.saveDocument({ ...target, etag: saved.document.etag, text: 'revoked grant' })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('\uFEFFchanged\r\n')
  })

  it('rejects escape paths and stale directory bindings without reading outside the workspace', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'outside.txt'), 'outside')
    await writeFile(join(f.workspace, 'inside.txt'), 'inside')
    // Windows directory junctions do not require the symlink creation privilege.
    // Keep file-symlink coverage on other platforms and exercise directory traversal on Windows.
    let escapePath = 'escape'
    if (process.platform === 'win32') {
      const outsideDirectory = join(f.root, 'outside-directory')
      await mkdir(outsideDirectory)
      await writeFile(join(outsideDirectory, 'outside.txt'), 'outside')
      await symlink(outsideDirectory, join(f.workspace, 'escape'), 'junction')
      escapePath = 'escape/outside.txt'
    }
    else {
      await symlink(join(f.root, 'outside.txt'), join(f.workspace, 'escape'))
    }
    expect((await f.files.list(f.target)).entries.find(entry => entry.name === 'escape')).toMatchObject({ unavailable: true })
    for (const path of ['../outside.txt', join(f.root, 'outside.txt'), escapePath])
      await expect(f.files.read({ ...f.target, path })).rejects.toThrow()
    await expect(f.files.read({ ...f.target, path: 'inside.txt', revision: 99 })).rejects.toThrow()
    await f.spaces.delete(f.target.spaceId)
    await expect(f.files.list(f.target)).rejects.toThrow()
    await expect(f.files.read({ ...f.target, path: 'inside.txt' })).rejects.toThrow()
    await expect(f.files.locate({ ...f.target, path: 'inside.txt' })).rejects.toThrow()
  })
})
