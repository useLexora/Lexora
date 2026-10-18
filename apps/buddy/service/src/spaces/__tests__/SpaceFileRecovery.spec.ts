import type { NativeFileOperation } from '../../files/NativeFileEngine'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeFileEngine } from '../../files/NativeFileEngine'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SpaceFileService } from '../SpaceFileService'
import { SpaceService } from '../SpaceService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse())
    await dispose()
})

async function fixture(crossDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), 'space-file-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const journal = join(root, 'journal')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  await writeFile(join(workspace, 'note.txt'), 'original')
  const original = new NativeFileEngine(journal)
  let record: NativeFileOperation
  try {
    await original.ready()
    await original.register('workspace', workspace)
    await original.register('outside', outside)
    record = await original.mutate({ operationId: randomUUID(), root: 'workspace', path: 'note.txt', action: { kind: 'copy', destinationRoot: crossDirectory ? 'outside' : 'workspace', destination: 'copied.txt' } })
  }
  finally {
    await original.dispose()
  }
  const journalDb = new DatabaseSync(join(journal, 'operations.sqlite'))
  record.status = 'executing'
  journalDb.prepare('UPDATE operations SET record=?,status=? WHERE id=?').run(JSON.stringify(record), JSON.stringify(record.status), record.operationId)
  journalDb.close()
  const engine = new NativeFileEngine(journal)
  cleanup.push(() => engine.dispose())
  await engine.ready()
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanup.push(async () => database.close())
  const repository = createSpaceRepository(database)
  const spaces = new SpaceService(repository)
  const space = await spaces.create({ name: 'Recovery', memoryScope: 'space_only', primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true })
  const files = new SpaceFileService(repository, engine)
  cleanup.push(() => files.dispose())
  const input = { spaceId: space.id, directoryId: space.primaryDirectory!.id, revision: space.primaryDirectory!.revision, path: '', operationId: record.operationId }
  const revoke = () => database.prepare('UPDATE space_directory_bindings SET revision=revision+1 WHERE id=?').run(input.directoryId)
  const replace = async () => {
    await rename(workspace, join(root, 'retained'))
    await mkdir(workspace)
    await writeFile(join(workspace, 'note.txt'), 'replacement')
  }
  return { root, workspace, outside, record, engine, files, spaces, input, revoke, replace }
}

describe('space file acknowledgement', () => {
  it('rejects the first acknowledgement after a history-bound directory is replaced', async () => {
    const f = await fixture()
    expect(await f.files.history(f.input)).toContainEqual(expect.objectContaining({ operationId: f.record.operationId, status: 'needs-recovery' }))
    await f.replace()
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: 'FILE_PERMISSION_REVOKED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
    await f.engine.register('replacement-probe', f.workspace)
    await expect(f.engine.acquire(randomUUID(), [{ root: 'replacement-probe', path: 'note.txt', subtree: false }])).rejects.toThrow('FILE_RECOVERY_REQUIRED')
    expect(await readFile(join(f.workspace, 'note.txt'), 'utf8')).toBe('replacement')
    expect(await readFile(join(f.root, 'retained', 'note.txt'), 'utf8')).toBe('original')
  })

  it('keeps cross-directory operations protected when only the primary directory is authorized', async () => {
    const f = await fixture(true)
    expect(await f.files.history(f.input)).toContainEqual(expect.objectContaining({ path: 'note.txt', destination: null }))
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: 'FILE_PERMISSION_REVOKED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
    await expect(f.files.mutate({ ...f.input, operationId: randomUUID(), path: 'note.txt', action: { kind: 'rename', destination: 'moved.txt' } })).rejects.toThrow('FILE_RECOVERY_REQUIRED')
  })

  it('accepts current state idempotently without replaying effects or deleting staging evidence', async () => {
    const f = await fixture()
    await f.files.history(f.input)
    await writeFile(join(f.workspace, 'note.txt'), 'reviewed source')
    await writeFile(join(f.workspace, 'copied.txt'), 'reviewed destination')
    const staging = f.record.receipt!.staging as string
    await writeFile(staging, 'retained evidence')
    const result = await f.files.acknowledge(f.input)
    expect(result).toMatchObject({ status: 'acknowledged', path: 'note.txt', destination: 'copied.txt', restorable: false })
    expect(await f.files.acknowledge(f.input)).toEqual(result)
    expect(await readFile(join(f.workspace, 'note.txt'), 'utf8')).toBe('reviewed source')
    expect(await readFile(join(f.workspace, 'copied.txt'), 'utf8')).toBe('reviewed destination')
    expect(await readFile(staging, 'utf8')).toBe('retained evidence')
    expect((await f.files.mutate({ ...f.input, operationId: randomUUID(), path: 'note.txt', action: { kind: 'rename', destination: 'moved.txt' } })).status).toBe('applied')
  })

  it.each(['source', 'destination', 'staging'] as const)('rejects a symlink redirect at the %s endpoint and retains protection', async (endpoint) => {
    const f = await fixture()
    await f.files.history(f.input)
    const path = endpoint === 'staging' ? f.record.receipt!.staging as string : f.record[endpoint]!
    await writeFile(join(f.outside, 'private.txt'), 'outside')
    await rm(path, { force: true })
    await symlink(join(f.outside, 'private.txt'), path)
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
    expect(await readFile(join(f.outside, 'private.txt'), 'utf8')).toBe('outside')
  })

  it('rejects stale and deleted Space permissions without releasing the operation', async () => {
    const f = await fixture()
    await f.files.history(f.input)
    await expect(f.files.acknowledge({ ...f.input, revision: f.input.revision + 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await f.spaces.delete(f.input.spaceId)
    await expect(f.files.acknowledge(f.input)).rejects.toThrow()
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
  })

  it('rechecks authorization after root registration and before native acknowledgement', async () => {
    const f = await fixture()
    await f.files.history(f.input)
    const register = f.engine.register.bind(f.engine)
    vi.spyOn(f.engine, 'register').mockImplementation(async (...args) => {
      const result = await register(...args)
      f.revoke()
      return result
    })
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
  })

  it('rechecks the existing root identity at the native acknowledgement boundary', async () => {
    const f = await fixture()
    await f.files.history(f.input)
    const acknowledge = f.engine.acknowledge.bind(f.engine)
    vi.spyOn(f.engine, 'acknowledge').mockImplementation(async (...args) => {
      await f.replace()
      return acknowledge(...args)
    })
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: 'FILE_PERMISSION_REVOKED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('needs-recovery')
  })

  it.each(['permission', 'identity'] as const)('denies a confirmation response when %s changes after native completion', async (change) => {
    const f = await fixture()
    await f.files.history(f.input)
    const acknowledge = f.engine.acknowledge.bind(f.engine)
    vi.spyOn(f.engine, 'acknowledge').mockImplementation(async (...args) => {
      const result = await acknowledge(...args)
      if (change === 'permission')
        f.revoke()
      else
        await f.replace()
      return result
    })
    await expect(f.files.acknowledge(f.input)).rejects.toMatchObject({ code: change === 'permission' ? 'VALIDATION_FAILED' : 'FILE_PERMISSION_REVOKED' })
    expect((await f.engine.query(f.record.operationId))?.status).toBe('acknowledged')
    expect(await readFile(join(change === 'identity' ? join(f.root, 'retained') : f.workspace, 'note.txt'), 'utf8')).toBe('original')
  })
})
