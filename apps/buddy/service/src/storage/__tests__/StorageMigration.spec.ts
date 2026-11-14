import type { StorageProgress } from '../../../../shared/storage/storageApi'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectWindowsPrivateDirectory as inspect } from '../../../../platform/filesystem/__tests__/windowsPrivateDirectoryFixture'
import { resolveBuddyPrivateDirectories } from '../../../../platform/native/nativeHost'
import { writeStorageJson } from '../../../../platform/storage/storageFiles'
import { StorageLocationStore } from '../../../../platform/storage/StorageLocationStore'
import { acquireStorageRootLease } from '../../../../platform/storage/StorageRootLease'
import { readDiagnosticError } from '../../../../shared/diagnostics/applicationDiagnostic'
import { SkillService } from '../../skills/SkillService'
import { createAttachmentPersistenceRepository } from '../attachmentPersistenceRepository'
import { BuddyDataPaths } from '../BuddyDataPaths'
import { CommandCommitter } from '../CommandCommitter'
import { restoreRetained, restoreStage } from '../commitBackupRestore'
import { openBuddyDatabase, openBuddySqliteDatabase } from '../database'
import { createSkillRepository } from '../skillRepository'
import { createSpaceRepository } from '../spaceRepository'
import { runStorageMigration } from '../StorageMigration'

const privateDirectoriesExecutable = resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false })
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture(sqlite = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-storage-'))
  directories.push(directory)
  const root = join(directory, 'a')
  await mkdir(join(root, 'buddy', 'drafts', 'draft'), { recursive: true })
  await writeFile(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), 'hello')
  await mkdir(join(root, 'buddy', 'empty'), { recursive: true })
  const identity = { version: 1 as const, layoutVersion: 1 as const, dataId: randomUUID(), generation: randomUUID() }
  await writeStorageJson(join(root, 'storage.json'), identity)
  const database = (sqlite ? openBuddySqliteDatabase : openBuddyDatabase)({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  if (sqlite)
    createAttachmentPersistenceRepository(database).adopt({ path: join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), sizeBytes: 5, sha256: createHash('sha256').update('hello').digest('hex') })
  database.prepare('INSERT INTO attachments (id, draft_id, stored_path, name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('file', 'draft', join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), 'hello.txt', 'text/plain', 5, '2026-01-01')
  database.close()
  const store = new StorageLocationStore(join(directory, 'bootstrap', 'location.json'), root)
  await store.write({ version: 1, activeRoot: root, identity, pending: null, history: [] })
  const run = (signal = new AbortController().signal) => runStorageMigration({ locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }, signal, () => { })
  return { directory, root, store, run }
}
it('moves A to B to C to A, preserving bytes, empty directories and attachment references', async () => {
  const { root, directory, store, run } = await fixture()
  await mkdir(join(root, '.runtime', 'electron'), { recursive: true })
  await writeFile(join(root, '.runtime', 'electron', 'lockfile'), 'transient lock')
  await writeFile(join(root, 'buddy', 'drafts', 'draft', 'lockfile'), 'user file')
  const soundId = randomUUID()
  await mkdir(join(root, 'buddy', 'notification-sounds'))
  await writeFile(join(root, 'buddy', 'notification-sounds', `${soundId}.audio`), 'managed sound')
  for (const target of [join(directory, 'b'), join(directory, 'c'), root]) {
    const source = (await store.read()).activeRoot
    await store.request('relocate', target)
    await run()
    const state = await store.read()
    expect(state.activeRoot).toBe(target)
    expect(state.pending).toBeNull()
    expect(JSON.parse(await readFile(join(source, '.storage-retired.json'), 'utf8')).target).toBe(target)
    await expect(readFile(join(target, '.storage-retired.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(target, 'buddy', 'drafts', 'draft', 'hello.txt'), 'utf8')).toBe('hello')
    expect(await readdir(join(target, 'buddy', 'empty'))).toEqual([])
    await expect(readFile(join(target, '.runtime', 'electron', 'lockfile'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(target, 'buddy', 'drafts', 'draft', 'lockfile'), 'utf8')).toBe('user file')
    expect(await readFile(join(target, 'buddy', 'notification-sounds', `${soundId}.audio`), 'utf8')).toBe('managed sound')
    const database = openBuddyDatabase({ databasePath: join(target, 'buddy', 'buddy.sqlite3') })
    expect(database.prepare('SELECT stored_path FROM attachments').get()?.stored_path).toBe(join(target, 'buddy', 'drafts', 'draft', 'hello.txt'))
    database.close()
  }
  expect((await store.read()).history).toHaveLength(3)
  expect((await readdir(directory)).some(name => name.includes('.retained-'))).toBe(true)
})
it('keeps the active source and a visible failure when a required attachment is missing', async () => {
  const { root, directory, store, run } = await fixture()
  await rm(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'))
  await store.request('relocate', join(directory, 'b'))
  await expect(run()).rejects.toThrow('STORAGE_REFERENCE_MISSING')
  expect(await store.read()).toMatchObject({ activeRoot: root, pending: { phase: 'failed' } })
  await writeFile(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), 'hello')
  await run()
  expect((await store.read()).pending).toBeNull()
})
it('never activates a cancelled copy or overwrites an unrelated target', async () => {
  const { root, directory, store, run } = await fixture()
  const target = join(directory, 'b')
  await mkdir(target)
  await writeFile(join(target, 'unrelated.txt'), 'keep')
  await expect(store.request('relocate', target)).rejects.toThrow('STORAGE_TARGET_NOT_EMPTY')
  await expect(store.request('relocate', join(root, 'child'))).rejects.toThrow('STORAGE_PATH_OVERLAP')
  await store.request('relocate', join(directory, 'c'))
  await expect(run(AbortSignal.abort())).rejects.toThrow('STORAGE_CANCELLED')
  expect((await store.read()).activeRoot).toBe(root)
  expect(await readFile(join(target, 'unrelated.txt'), 'utf8')).toBe('keep')
})
it('consolidates legacy state once and resumes an interrupted import without changing the source', async () => {
  const { directory, root, store } = await fixture()
  await rm(join(root, 'storage.json'))
  const legacy = join(directory, 'legacy')
  await mkdir(join(legacy, 'browser'), { recursive: true })
  await mkdir(join(legacy, 'state'), { recursive: true })
  await writeFile(join(legacy, 'browser', 'Cookies'), 'synthetic-session')
  await writeFile(join(legacy, 'state', 'window-state.json'), '{"x":10}')
  const state = await store.read()
  const id = randomUUID()
  await store.write({ ...state, identity: null, pending: { id, kind: 'consolidate', source: root, target: root, phase: 'pending', error: null, createdAt: new Date().toISOString() } })
  const input = { locationPath: store.path, defaultRoot: root, privateDirectoriesExecutable, legacySources: [{ source: join(legacy, 'browser'), destination: 'device/chromium' }, { source: join(legacy, 'state'), destination: 'device/state' }] }
  const controller = new AbortController()
  await expect(runStorageMigration(input, controller.signal, (progress) => {
    if (progress.phase === 'copying' && progress.files === 1)
      controller.abort()
  })).rejects.toThrow('STORAGE_CANCELLED')
  await runStorageMigration(input, new AbortController().signal, () => {})
  expect(await readFile(join(root, 'device', 'chromium', 'Cookies'), 'utf8')).toBe('synthetic-session')
  expect(await readFile(join(root, 'device', 'state', 'window-state.json'), 'utf8')).toBe('{"x":10}')
  expect(await readFile(join(legacy, 'browser', 'Cookies'), 'utf8')).toBe('synthetic-session')
  expect(await store.read()).toMatchObject({ pending: null, identity: { generation: id } })
})

it('consolidates durable browser data with aggregate progress while leaving caches and diagnostics untouched', async () => {
  const { directory, root, store } = await fixture()
  await rm(join(root, 'storage.json'))
  const legacy = join(directory, 'legacy')
  const kept = ['browser/Cookies', 'browser/Local Storage/store', 'browser/IndexedDB/Cache/user-data', 'browser/Service Worker/CacheStorage/offline', 'browser/Partitions/site/Cookies', 'state/window-state.json']
  const skipped = ['browser/Cache/data', 'browser/Code Cache/data', 'browser/GPUCache/data', 'browser/Partitions/site/Cache/data', 'state/logs/old.log', 'state/crashes/report', 'logs/old.log', 'crashes/report']
  for (const path of [...kept, ...skipped]) {
    await mkdir(join(legacy, path, '..'), { recursive: true })
    await writeFile(join(legacy, path), 'fixture')
  }
  const state = await store.read()
  await store.write({ ...state, identity: null, pending: { id: randomUUID(), kind: 'consolidate', source: root, target: root, phase: 'pending', error: null, createdAt: new Date().toISOString() } })
  const sources = [{ source: join(legacy, 'browser'), destination: 'device/chromium' }, { source: join(legacy, 'state'), destination: 'device/state' }, { source: join(legacy, 'logs'), destination: 'logs' }, { source: join(legacy, 'crashes'), destination: 'device/crashes' }]
  const progress: StorageProgress[] = []
  await runStorageMigration({ locationPath: store.path, defaultRoot: root, privateDirectoriesExecutable, legacySources: sources }, new AbortController().signal, update => progress.push({ ...update }))
  for (const path of kept)
    expect(await readFile(join(root, path.replace(/^browser\//, 'device/chromium/').replace(/^state\//, 'device/state/')), 'utf8')).toBe('fixture')
  for (const path of skipped) {
    expect(await readFile(join(legacy, path), 'utf8')).toBe('fixture')
    await expect(readFile(join(root, path.replace(/^browser\//, 'device/chromium/').replace(/^state\//, 'device/state/').replace(/^crashes\//, 'device/crashes/')))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  const copies = progress.filter(update => update.phase === 'copying')
  expect(copies.every(update => update.totalBytes === kept.length * 7)).toBe(true)
  expect(copies.map(update => update.completedBytes)).toEqual(copies.map(update => update.completedBytes).sort((a, b) => a - b))
  expect(copies.at(-1)).toMatchObject({ files: kept.length, completedBytes: kept.length * 7 })
})

it('skips rebuildable profile caches during later directory moves but keeps user files named Cache', async () => {
  const { directory, root, store, run } = await fixture()
  const kept = ['device/chromium/Cookies', 'device/chromium/Partitions/site/IndexedDB/data', 'buddy/conversations/task/workspace/Cache/data']
  const skipped = ['device/chromium/Cache/data', 'device/electron/Code Cache/data', 'device/chromium/Partitions/site/GPUCache/data', 'cache/updates/installer', 'logs/old.log', 'device/state/logs/old.log', 'device/crashes/report']
  for (const path of [...kept, ...skipped]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), 'fixture')
  }
  const target = join(directory, 'moved')
  await store.request('relocate', target)
  await run()
  for (const path of kept)
    expect(await readFile(join(target, path), 'utf8')).toBe('fixture')
  for (const path of skipped) {
    expect(await readFile(join(root, path), 'utf8')).toBe('fixture')
    await expect(readFile(join(target, path))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('keeps global Skill identity, enabled state and discovery usable after a real move', async () => {
  const { root, directory, store, run } = await fixture()
  const skillRoot = join(root, 'buddy', 'agent', 'skills', 'fixture')
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture skill\n---\nFixture body\n')
  const catalog = async (path: string) => {
    const database = openBuddyDatabase({ databasePath: join(path, 'buddy', 'buddy.sqlite3') })
    const service = new SkillService({ agentDirectory: join(path, 'buddy', 'agent'), builtinSkillsDirectories: [], paths: new BuddyDataPaths(join(path, 'buddy')), repository: createSkillRepository(database), spaces: createSpaceRepository(database) })
    try {
      return await service.list(null)
    }
    finally {
      await service.dispose()
      database.close()
    }
  }
  const before = (await catalog(root)).skills[0]!
  expect(before).toMatchObject({ name: 'fixture', status: 'available', enabled: true })
  const target = join(directory, 'moved')
  await store.request('relocate', target)
  await run()
  expect((await catalog(target)).skills[0]).toMatchObject({ id: before.id, name: before.name, status: 'available', enabled: true })
})

it('finishes activation after the commit point even if cancellation arrives', async () => {
  const { root, directory, store } = await fixture()
  const file = join(root, 'buddy', 'drafts', 'draft', 'hello.txt')
  await chmod(file, 0o444)
  const target = join(directory, 'committed')
  await store.request('relocate', target)
  const controller = new AbortController()
  const phases: string[] = []
  await runStorageMigration({ locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }, controller.signal, (progress) => {
    phases.push(progress.phase)
    if (progress.phase === 'activating')
      controller.abort()
  })
  expect(await store.read()).toMatchObject({ activeRoot: target, pending: null })
  expect(phases.at(-1)).toBe('completed')
  expect(await readFile(join(target, 'buddy', 'drafts', 'draft', 'hello.txt'), 'utf8')).toBe('hello')
})

it.skipIf(process.platform !== 'win32')('creates the migrated profile with private ACLs under a permissive parent', async () => {
  const { root, directory, store, run } = await fixture()
  const parent = join(directory, 'shared-parent')
  await mkdir(parent)
  const additional = 'S-1-5-21-111111111-222222222-333333333-1001'
  const before = inspect(parent, `D:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${additional})`)
  const target = join(parent, 'profile')
  await store.request('relocate', target)
  await run()
  expect(inspect(target).protected).toBe(true)
  expect(inspect(target).allows).not.toContain(additional)
  expect(inspect(join(target, 'buddy', 'buddy.sqlite3')).allows).not.toContain(additional)
  expect(inspect(parent).sddl).toBe(before.sddl)
  expect(await readFile(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), 'utf8')).toBe('hello')
}, 60000)

it('resumes an interrupted commit without reopening cancellation or recopying the source', async () => {
  const { root, directory, store, run } = await fixture()
  const target = join(directory, 'committed')
  await store.request('relocate', target)
  const cause = Object.assign(new Error('private-fixture-path-or-content'), { code: 'EACCES' })
  const activate = vi.spyOn(StorageLocationStore.prototype, 'activate').mockRejectedValueOnce(cause)
  const failure = await run().catch((error: unknown) => error)
  expect(failure).toMatchObject({ message: 'STORAGE_MIGRATION_FAILED', cause })
  expect(readDiagnosticError(failure)).toEqual({ errorCode: 'EACCES', errorType: 'Error' })
  activate.mockRestore()
  expect(await store.read()).toMatchObject({ activeRoot: root, pending: { phase: 'ready' } })
  await expect(store.cancel()).rejects.toThrow('STORAGE_COMMITTING')
  await writeFile(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'), 'source changed after verified copy')
  await run(AbortSignal.abort())
  expect(await store.read()).toMatchObject({ activeRoot: target, pending: null })
  expect(await readFile(join(target, 'buddy', 'drafts', 'draft', 'hello.txt'), 'utf8')).toBe('hello')
})

it('relocates SQLite authority without changing receipts, file identities or source bytes', async () => {
  const { root, directory, store, run } = await fixture(true)
  const databasePath = join(root, 'buddy/buddy.sqlite3')
  const source = openBuddySqliteDatabase({ databasePath })
  const identity = source.prepare('SELECT * FROM storage_profile').get()!
  const file = source.prepare('SELECT * FROM managed_files').get()!
  const references = source.prepare('SELECT * FROM file_references').all()
  const original = new CommandCommitter(source).accept({ dataGeneration: String(identity.data_generation), actorId: 'desktop-local', commandId: 'preserved-receipt', method: 'composerDrafts.save', fingerprint: 'fingerprint', fingerprintVersion: 1, sourceInstanceId: 'original-instance' }, () => ({ target: { draftId: 'draft' }, result: { revision: 1 } })).receipt
  source.close()
  const before = await readFile(databasePath)
  const target = join(directory, 'moved')
  await store.request('relocate', target)
  await run()
  expect(await readFile(databasePath)).toEqual(before)
  expect((await store.read()).activeRoot).toBe(target)
  const moved = openBuddySqliteDatabase({ databasePath: join(target, 'buddy/buddy.sqlite3') })
  try {
    expect(moved.prepare('SELECT * FROM storage_profile').get()).toEqual(identity)
    expect(new CommandCommitter(moved).find(original)).toEqual(original)
    expect(moved.prepare('SELECT * FROM file_references').all()).toEqual(references)
    expect(moved.prepare('SELECT * FROM managed_files').get()).toEqual({ ...file, path: join(target, 'buddy/drafts/draft/hello.txt') })
    expect(moved.prepare('SELECT stored_path FROM attachments').get()?.stored_path).toBe(join(target, 'buddy/drafts/draft/hello.txt'))
    expect(await readFile(join(target, 'buddy/drafts/draft/hello.txt'), 'utf8')).toBe('hello')
    expect(moved.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() => moved.exec('DELETE FROM command_receipts')).toThrow('IMMUTABLE')
    expect(() => moved.exec('DELETE FROM managed_files')).toThrow('IMMUTABLE')
  }
  finally { moved.close() }
})

it('upgrades in place, retains original bytes and preserves references and device settings', async () => {
  const { root, store, run } = await fixture()
  const original = await readFile(join(root, 'buddy', 'buddy.sqlite3'))
  await writeFile(join(root, 'config.toml'), '[desktop]\nexit_behavior = "stop_service"\n')
  const untouched = ['buddy/unknown-data/file.bin', 'buddy/extensions/inference/model.bin', 'buddy/backups/snapshot.bin', 'buddy/themes/custom/theme.json', 'device/chromium/Cache/page', 'recovery/previous/buddy.sqlite3']
  for (const path of untouched) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), 'preserve in place')
  }
  const identities = await Promise.all(untouched.map(path => lstat(join(root, path))))
  const requested = await store.request('upgrade', root)
  await run()
  const state = await store.read()
  expect(state).toMatchObject({ activeRoot: root, pending: null, identity: { generation: requested.pending!.id } })
  const retained = state.history.at(-1)!.retainedTarget!
  for (const [index, path] of untouched.entries()) {
    expect(await lstat(join(root, path))).toMatchObject({ ino: identities[index]!.ino, mtimeMs: identities[index]!.mtimeMs })
    expect(await readFile(join(root, path), 'utf8')).toBe('preserve in place')
    await expect(lstat(join(retained, path))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await readFile(join(retained, 'buddy', 'buddy.sqlite3'))).toEqual(original)
  expect(await readFile(join(retained, 'buddy', 'drafts', 'draft', 'hello.txt'), 'utf8')).toBe('hello')
  expect(await readFile(join(root, 'config.toml'), 'utf8')).toBe('[desktop]\nexit_behavior = "stop_service"\n')
  const database = openBuddySqliteDatabase({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  try {
    expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toMatchObject({ authority: 'sqlite', migration_state: 'ready' })
    expect(database.prepare('SELECT stored_path FROM attachments').get()?.stored_path).toBe(join(root, 'buddy', 'drafts', 'draft', 'hello.txt'))
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
  finally { database.close() }
})

it('refuses to migrate an actively used source and can retry after the owner exits', async () => {
  const { root, directory, store, run } = await fixture()
  await store.request('upgrade', root)
  const release = acquireStorageRootLease(root, join(directory, 'locks'), privateDirectoriesExecutable)
  try {
    await expect(run()).rejects.toThrow('STORAGE_ROOT_IN_USE')
    expect((await store.read()).pending?.phase).toBe('failed')
  }
  finally { release() }
  await run()
  expect((await store.read()).pending).toBeNull()
})

it.each(['retained', 'installed', 'legacy-retained', 'legacy-installed'])('recovers an upgrade interrupted after the original data is %s', async (point) => {
  const { root, directory, store, run } = await fixture()
  const original = await readFile(join(root, 'buddy', 'buddy.sqlite3'))
  const operation = (await store.request('upgrade', root)).pending!
  await expect(runStorageMigration({ locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }, new AbortController().signal, (progress) => {
    if (progress.phase === 'activating')
      throw new Error('STORAGE_TEST_INTERRUPTED')
  })).rejects.toThrow('STORAGE_TEST_INTERRUPTED')
  expect((await store.read()).pending?.phase).toBe('ready')
  const path = point.startsWith('legacy-') ? 'buddy' : 'buddy/buddy.sqlite3'
  if (point.startsWith('legacy-'))
    await writeStorageJson(join(restoreStage(operation), 'commit.json'), { id: operation.id, entries: [{ path, original: true }] })
  await mkdir(join(restoreRetained(operation), path, '..'), { recursive: true })
  await rename(join(root, path), join(restoreRetained(operation), path))
  if (point.endsWith('installed'))
    await rename(join(restoreStage(operation), 'profile', path), join(root, path))
  await expect(store.cancel()).rejects.toThrow('STORAGE_COMMITTING')
  await run(AbortSignal.abort())
  expect(await store.read()).toMatchObject({ activeRoot: root, pending: null, identity: { generation: operation.id } })
  expect(await readFile(join(restoreRetained(operation), 'buddy', 'buddy.sqlite3'))).toEqual(original)
  const database = openBuddySqliteDatabase({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  database.close()
})

it('reports real upgrade progress and retries an interrupted copy without reusing its partial candidate', async () => {
  const { root, directory, store } = await fixture()
  const operation = (await store.request('upgrade', root)).pending!
  const input = { locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }
  const original = await readFile(join(root, 'buddy/buddy.sqlite3'))
  const controller = new AbortController()
  const updates: StorageProgress[] = []
  await expect(runStorageMigration(input, controller.signal, (progress) => {
    updates.push(progress)
    if (progress.phase === 'copying' && progress.completedBytes > 0)
      controller.abort()
  })).rejects.toThrow('STORAGE_CANCELLED')
  expect(updates.some(update => update.phase === 'preparing' && update.files > 0)).toBe(true)
  expect(updates.some(update => update.phase === 'copying' && update.totalBytes! > 0)).toBe(true)
  expect(await readFile(join(root, 'buddy/buddy.sqlite3'))).toEqual(original)
  const stale = join(restoreStage(operation), 'candidate/source/buddy/extensions')
  await mkdir(stale, { recursive: true })
  await writeFile(join(stale, 'partial.bin'), 'old interrupted copy')
  await runStorageMigration(input, new AbortController().signal, progress => updates.push(progress))
  expect((await store.read()).pending).toBeNull()
  expect(updates.some(update => update.phase === 'copying' && update.files > 0 && update.completedBytes === update.totalBytes)).toBe(true)
  expect(updates.some(update => update.phase === 'verifying' && update.files > 0)).toBe(true)
  await expect(lstat(restoreStage(operation))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(root, 'buddy/extensions'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('imports uncheckpointed WAL data and retires old sidecars when replacing the database', async () => {
  const { root, store, run } = await fixture()
  const path = join(root, 'buddy/buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath: path })
  database.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run('wal-task', '2026-01-01', '2026-01-01')
  const snapshot = await Promise.all(['', '-wal', '-shm'].map(suffix => readFile(`${path}${suffix}`)))
  database.close()
  await Promise.all(['', '-wal', '-shm'].map((suffix, index) => writeFile(`${path}${suffix}`, snapshot[index]!)))
  await store.request('upgrade', root)
  await run()
  const retained = (await store.read()).history.at(-1)!.retainedTarget!
  for (const [index, suffix] of ['', '-wal', '-shm'].entries())
    expect(await readFile(join(retained, `buddy/buddy.sqlite3${suffix}`))).toEqual(snapshot[index])
  for (const suffix of ['-wal', '-shm'])
    await expect(lstat(`${path}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' })
  const upgraded = openBuddySqliteDatabase({ databasePath: path })
  try {
    expect(upgraded.prepare('SELECT id FROM conversations').get()?.id).toBe('wal-task')
  }
  finally { upgraded.close() }
})
