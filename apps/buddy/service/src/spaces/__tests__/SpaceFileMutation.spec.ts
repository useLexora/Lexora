import type { BoundedEntryMutation, BoundedEntryMutationResult } from '../../../../platform/filesystem/mutateBoundedEntry'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mutateBoundedEntry } from '../../../../platform/filesystem/mutateBoundedEntry'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SpaceFileService } from '../SpaceFileService'
import { SpaceService } from '../SpaceService'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0))
    await dispose()
})
async function fixture(mutator?: ConstructorParameters<typeof SpaceFileService>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'lexora-file-mutation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createSpaceRepository(database)
  const spaces = new SpaceService(repository)
  const space = await spaces.create({ name: 'Files', memoryScope: 'space_only', primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true })
  const files = new SpaceFileService(repository, mutator)
  cleanup.push(async () => {
    await files.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const target = { spaceId: space.id, directoryId: space.primaryDirectory!.id, revision: space.primaryDirectory!.revision, path: '' }
  return { database, root, workspace, files, spaces, target }
}

describe('space file mutation boundary', () => {
  it('refuses traversal, root rename/delete, invalid names and stale grants before dispatch', async () => {
    const adapter = vi.fn(async () => ({ status: 'completed', kind: 'file' } as const))
    const f = await fixture(adapter)
    for (const path of ['../outside', '/outside', 'a/../b', 'a\\b', 'a//b', './a'])
      expect(await f.files.mutate({ ...f.target, path, operation: 'create-file', name: 'note' })).toEqual({ status: 'failed', reason: 'unsafe-path' })
    expect(await f.files.mutate({ ...f.target, operation: 'rename', name: 'new-root' })).toMatchObject({ reason: 'unsafe-path' })
    expect(await f.files.mutate({ ...f.target, operation: 'trash' })).toMatchObject({ reason: 'unsafe-path' })
    expect(await f.files.mutate({ ...f.target, operation: 'create-file', name: '../note' })).toMatchObject({ reason: 'invalid-name' })
    expect(await f.files.mutate({ ...f.target, path: 'note.md', operation: 'rename', name: 'NOTE.md' })).toMatchObject({ reason: 'case-only' })
    await expect(async () => f.files.mutate({ ...f.target, revision: 99, operation: 'create-file', name: 'note' })).rejects.toThrow()
    expect(adapter).not.toHaveBeenCalled()
  })
  it('serializes a directory with a simple busy state and blocks concurrent reads/saves', async () => {
    let finish!: (result: BoundedEntryMutationResult) => void
    const f = await fixture(async (_input, beforeCommit) => {
      beforeCommit()
      return new Promise(resolve => finish = resolve)
    })
    const pending = f.files.mutate({ ...f.target, operation: 'create-file', name: 'one' })
    await Promise.resolve()
    expect(await f.files.mutate({ ...f.target, operation: 'create-directory', name: 'two' })).toMatchObject({ reason: 'busy' })
    await expect(f.files.readDocument({ ...f.target, path: 'note' })).rejects.toThrow()
    await expect(f.files.saveDocument({ ...f.target, path: 'note', text: '', etag: 'a'.repeat(64) })).rejects.toThrow()
    finish({ status: 'completed', kind: 'file' })
    expect(await pending).toMatchObject({ status: 'completed', path: 'one' })
    await expect(f.files.readDocument({ ...f.target, path: 'note' })).rejects.not.toThrow('SPACE_FILES_STOPPED')
  })
  it('rechecks authorization immediately before commit', async () => {
    let committed = false
    const f = await fixture(async (_input, beforeCommit) => {
      f.database.prepare('UPDATE space_directory_bindings SET revision = revision + 1 WHERE id = ?').run(f.target.directoryId)
      beforeCommit()
      committed = true
      return { status: 'completed', kind: 'file' }
    })
    await expect(f.files.mutate({ ...f.target, operation: 'create-file', name: 'note' })).rejects.toThrow()
    expect(committed).toBe(false)
    expect(await readdir(f.workspace)).toEqual([])
  })
  it('reports result-unknown, not a rollback, if authorization changes after a committed result', async () => {
    const f = await fixture(async (_input, beforeCommit) => {
      beforeCommit()
      return { status: 'completed', kind: 'file' }
    })
    f.files.onDidChange((event) => {
      if (event.kind === 'mutated')
        f.database.prepare('UPDATE space_directory_bindings SET revision = revision + 1 WHERE id = ?').run(f.target.directoryId)
    })
    expect(await f.files.mutate({ ...f.target, operation: 'create-file', name: 'note' })).toEqual({ status: 'failed', reason: 'result-unknown' })
  })
  it('never falls back to deletion when recycling is unavailable', async () => {
    const adapter = vi.fn(async (_input: BoundedEntryMutation, beforeCommit: () => void) => {
      beforeCommit()
      return { status: 'failed', reason: 'unsupported' } as const
    })
    const f = await fixture(adapter)
    await writeFile(join(f.workspace, 'keep.md'), 'keep')
    expect(await f.files.mutate({ ...f.target, path: 'keep.md', operation: 'trash' })).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(await readFile(join(f.workspace, 'keep.md'), 'utf8')).toBe('keep')
    expect(adapter).toHaveBeenCalledOnce()
    expect(adapter.mock.calls[0]![0].operation).toBe('trash')
  })
})

describe.runIf(process.platform === 'win32')('windows native file mutations', () => {
  it('recycles a file and a non-empty folder, then restores only these temporary fixtures', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'recover-中文😀.md'), 'recover file')
    await mkdir(join(f.workspace, 'recover-folder'))
    await writeFile(join(f.workspace, 'recover-folder', 'child.md'), 'recover child')
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.md'), 'outside remains untouched')
    await symlink(outside, join(f.workspace, 'recover-folder', 'outside-link'), 'junction')
    const results = []
    try {
      results.push(await f.files.mutate({ ...f.target, path: 'recover-中文😀.md', operation: 'trash' }))
      results.push(await f.files.mutate({ ...f.target, path: 'recover-folder', operation: 'trash' }))
      expect(await readdir(f.workspace)).toEqual([])
      expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('outside remains untouched')
    }
    finally {
      // Only items deleted from this test's unique temporary directory may be restored.
      // Never empty the Recycle Bin or enumerate personal file contents.
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        $shell = New-Object -ComObject Shell.Application
        $items = @($shell.Namespace(10).Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $env:LEXORA_RECYCLE_FIXTURE })
        foreach ($item in $items) { $item.InvokeVerb('undelete') }
        $deadline = (Get-Date).AddSeconds(10)
        while ((!(Test-Path (Join-Path $env:LEXORA_RECYCLE_FIXTURE 'recover-中文😀.md')) -or !(Test-Path (Join-Path $env:LEXORA_RECYCLE_FIXTURE 'recover-folder/child.md'))) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        Write-Output $items.Count
      `], { timeout: 15_000, windowsHide: true, env: { ...process.env, LEXORA_RECYCLE_FIXTURE: f.workspace } })
      expect(stdout.trim()).toBe('2')
    }
    expect(results).toEqual([{ status: 'completed', path: '', kind: 'file' }, { status: 'completed', path: '', kind: 'directory' }])
    expect(await readFile(join(f.workspace, 'recover-中文😀.md'), 'utf8')).toBe('recover file')
    expect(await readFile(join(f.workspace, 'recover-folder', 'child.md'), 'utf8')).toBe('recover child')
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('outside remains untouched')
  }, 25_000)
  it('creates and renames files and non-empty directories without covering existing entries', async () => {
    const f = await fixture()
    expect(await f.files.mutate({ ...f.target, operation: 'create-file', name: 'one.md' })).toEqual({ status: 'completed', path: 'one.md', kind: 'file' })
    expect(await readFile(join(f.workspace, 'one.md'), 'utf8')).toBe('')
    await writeFile(join(f.workspace, 'one.md'), 'keep')
    expect(await f.files.mutate({ ...f.target, operation: 'create-file', name: 'one.md' })).toMatchObject({ reason: 'exists' })
    expect(await f.files.mutate({ ...f.target, operation: 'create-file', name: 'two.md' })).toMatchObject({ status: 'completed' })
    expect(await f.files.mutate({ ...f.target, path: 'one.md', operation: 'rename', name: 'two.md' })).toMatchObject({ reason: 'exists' })
    expect(await readFile(join(f.workspace, 'one.md'), 'utf8')).toBe('keep')
    expect(await f.files.mutate({ ...f.target, path: 'one.md', operation: 'rename', name: 'renamed.md' })).toEqual({ status: 'completed', path: 'renamed.md', kind: 'file' })
    expect(await f.files.mutate({ ...f.target, operation: 'create-directory', name: 'folder' })).toMatchObject({ status: 'completed' })
    expect(await f.files.mutate({ ...f.target, path: 'folder', operation: 'create-file', name: 'child.md' })).toMatchObject({ path: 'folder/child.md' })
    expect(await f.files.mutate({ ...f.target, path: 'folder', operation: 'rename', name: 'new-folder' })).toMatchObject({ path: 'new-folder', kind: 'directory' })
    expect(await readFile(join(f.workspace, 'new-folder', 'child.md'), 'utf8')).toBe('')
  })
  it('rejects junction entries and junction ancestors even when they lead inside the root', async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, 'real'))
    await writeFile(join(f.workspace, 'real', 'keep.md'), 'keep')
    await symlink(join(f.workspace, 'real'), join(f.workspace, 'link'), 'junction')
    expect((await f.files.list(f.target)).entries.find(entry => entry.name === 'link')).toMatchObject({ writable: false })
    for (const mutation of [
      { ...f.target, path: 'link', operation: 'rename', name: 'wrong' } as const,
      { ...f.target, path: 'link', operation: 'trash' } as const,
      { ...f.target, path: 'link', operation: 'create-file', name: 'wrong' } as const,
      { ...f.target, path: 'link/keep.md', operation: 'rename', name: 'wrong' } as const,
    ])
      expect(await f.files.mutate(mutation)).toMatchObject({ status: 'failed', reason: 'unsafe-path' })
    expect(await readFile(join(f.workspace, 'real', 'keep.md'), 'utf8')).toBe('keep')
    expect(await readdir(join(f.workspace, 'real'))).toEqual(['keep.md'])
  })
  it('cancels the prepared native request if the grant is revoked during its final check', async () => {
    const f = await fixture((input, beforeCommit) => mutateBoundedEntry(input, () => {
      f.database.prepare('UPDATE space_directory_bindings SET revision = revision + 1 WHERE id = ?').run(f.target.directoryId)
      beforeCommit()
    }))
    await expect(f.files.mutate({ ...f.target, operation: 'create-file', name: 'never-created' })).rejects.toThrow()
    expect(await readdir(f.workspace)).toEqual([])
  })
})
