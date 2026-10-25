import type { BackupScope } from '../../../../shared/storage/backupScope'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { parse } from 'smol-toml'
import { afterEach, expect, it, vi } from 'vitest'
import { LexoraConfigStore } from '../../../../electron/main/config/LexoraConfigStore'
import { NotificationSoundLibrary } from '../../../../electron/main/notifications/NotificationSoundLibrary'
import { resolveBuddyPrivateDirectories } from '../../../../platform/native/nativeHost'
import { copySnapshot } from '../../../../platform/storage/copySnapshot'
import { extractSnapshotFiles } from '../../../../platform/storage/extractSnapshotFiles'
import { notificationSoundPath, writeNotificationSoundFile } from '../../../../platform/storage/notificationSoundFiles'
import { writeStorageJson } from '../../../../platform/storage/storageFiles'
import { StorageLocationStore } from '../../../../platform/storage/StorageLocationStore'
import { restoreCredentialStage } from '../../../../platform/storage/storageOperationFiles'
import { extensionManifestSchema } from '../../../../shared/extensions/extensionManifest'
import { backupScopes } from '../../../../shared/storage/backupScope'
import { conversationImageDirectory, ImageBlobStore } from '../../attachments/ImageBlobStore'
import { prepareRestoreCommit, restoreRetained, restoreStage } from '../commitBackupRestore'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { prepareBackupRestore } from '../restoreBackup'
import { runStorageMigration } from '../StorageMigration'
import { createStorageSnapshot, snapshotDirectory, verifyStorageSnapshot } from '../StorageSnapshots'

const privateDirectoriesExecutable = resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false })
const directories: string[] = []
const signal = new AbortController().signal
function report() {}
const now = '2026-10-14T00:00:00.000Z'
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-selective-backup-'))
  directories.push(directory)
  const root = join(directory, 'profile')
  const identity = { version: 1 as const, layoutVersion: 1 as const, dataId: randomUUID(), generation: randomUUID() }
  await writeStorageJson(join(root, 'storage.json'), identity)
  const store = new StorageLocationStore(join(directory, 'bootstrap', 'location.json'), root)
  await store.write({ version: 1, activeRoot: root, identity, pending: null, history: [] })
  const database = () => openBuddyDatabase({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  database().close()
  const input = { locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }
  const snapshot = (scopes: BackupScope[] = [...backupScopes]) => createStorageSnapshot(root, identity.dataId, signal, report, privateDirectoriesExecutable, { scopes, credentials: false })
  const run = () => runStorageMigration(input, signal, report)
  return { root, directory, store, database, snapshot, run }
}
it('restores sound settings and managed bytes without replacing current assets, and reuses remapped identities on repeat restore', async () => {
  const source = await fixture()
  const sourceConfig = new LexoraConfigStore({ configPath: join(source.root, 'config.toml') })
  const sourceLibrary = new NotificationSoundLibrary({ home: join(source.root, 'buddy'), configStore: sourceConfig, applyConfig: () => {} })
  const importedBytes = Buffer.from('trusted imported audio fixture')
  const imported = await sourceLibrary.add(importedBytes, { name: 'Imported', mimeType: 'audio/wav', durationMs: 900 })
  await sourceConfig.update({ desktop: { notificationSound: { selected: imported.id, volume: 0.3 } } })
  const orphan = randomUUID()
  await writeNotificationSoundFile(join(source.root, 'buddy'), orphan, Buffer.from('orphan'))
  const snapshot = await source.snapshot(['settings'])
  expect(snapshot.files.some(file => file.path === `buddy/notification-sounds/${imported.id}.audio`)).toBe(true)
  expect(snapshot.files.some(file => file.path.includes(orphan))).toBe(false)
  const providersOnly = await source.snapshot(['providers'])
  expect(providersOnly.files.some(file => file.path.startsWith('buddy/notification-sounds'))).toBe(false)

  const target = await fixture()
  const targetConfig = new LexoraConfigStore({ configPath: join(target.root, 'config.toml') })
  const targetHome = join(target.root, 'buddy')
  const targetLibrary = new NotificationSoundLibrary({ home: targetHome, configStore: targetConfig, applyConfig: () => {} })
  const currentBytes = Buffer.from('different current audio fixture')
  const currentAsset = { ...imported, name: 'Current' }
  await writeNotificationSoundFile(targetHome, imported.id, currentBytes)
  await targetConfig.addNotificationSound(currentAsset, () => {})
  const unrelated = await targetLibrary.add(Buffer.from('unrelated audio'), { name: 'Unrelated', mimeType: 'audio/mpeg', durationMs: 600 })
  await targetConfig.update({ desktop: { notificationSound: { selected: unrelated.id }, profile: { deviceName: 'Current device' } } })
  await copySnapshot(snapshotDirectory(source.root, snapshot.id), snapshotDirectory(target.root, snapshot.id), { signal, report, privateDirectoriesExecutable })
  let selected: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    await target.store.request('restore', target.root, [], snapshot.id, ['settings'])
    await target.run()
    const config = await targetConfig.read()
    const sound = config.desktop.notificationSound
    expect(sound.volume).toBe(0.3)
    expect(sound.selected).not.toBe(imported.id)
    if (selected)
      expect(sound.selected).toBe(selected)
    selected = sound.selected
    expect(sound.sounds).toHaveLength(3)
    expect(sound.sounds).toContainEqual(currentAsset)
    expect(sound.sounds).toContainEqual(unrelated)
    expect(sound.sounds).toContainEqual({ ...imported, id: selected })
    expect(config.desktop.profile.deviceName).toBe('Current device')
    expect(await targetLibrary.read(selected)).toEqual(importedBytes)
    expect(await readFile(notificationSoundPath(targetHome, imported.id))).toEqual(currentBytes)
    expect(await targetLibrary.read(unrelated.id)).toEqual(Buffer.from('unrelated audio'))
  }
})

it('restores selected providers in place while retaining newer tasks, plugins, settings and unrelated providers', async () => {
  const f = await fixture()
  const db = f.database()
  db.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)').run('selected', now, now)
  createConversationRepository(db).create({ id: 'task', branchId: 'branch', title: 'Original', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  db.close()
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), { value: 'original' })
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "zh-CN"\n')
  const snapshot = await f.snapshot()
  const current = f.database()
  current.prepare('UPDATE provider_states SET enabled = 0 WHERE provider_id = ?').run('selected')
  current.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at, request_headers_json) VALUES (?, 1, ?, ?, ?)').run('unrelated', now, now, '[{"name":"X-Fixture","value":"preserve"}]')
  current.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('Newer task', 'task')
  current.close()
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), { value: 'newer' })
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "en-US"\n')
  await f.store.request('restore', f.root, [], snapshot.id, ['providers'])
  await f.run()
  const restored = f.database()
  expect(restored.prepare('SELECT enabled FROM provider_states WHERE provider_id = ?').get('selected')?.enabled).toBe(1)
  expect(restored.prepare('SELECT request_headers_json FROM provider_states WHERE provider_id = ?').get('unrelated')?.request_headers_json).toContain('preserve')
  expect(restored.prepare('SELECT title FROM conversations WHERE id = ?').get('task')?.title).toBe('Newer task')
  expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  restored.close()
  expect(JSON.parse(await readFile(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), 'utf8'))).toEqual({ value: 'newer' })
  expect(await readFile(join(f.root, 'config.toml'), 'utf8')).toContain('en-US')
  expect(await f.store.read()).toMatchObject({ activeRoot: f.root, pending: null })
  expect((await verifyStorageSnapshot(snapshotDirectory(f.root, snapshot.id), signal)).id).toBe(snapshot.id)
})
it('imports a task backup into another profile without duplicating publications or replacing an existing buddy', async () => {
  const source = await fixture()
  const db = source.database()
  const conversations = createConversationRepository(db)
  conversations.create({ id: 'imported', branchId: 'imported-branch', title: 'Imported task', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  conversations.createMessage({ id: 'input', conversationId: 'imported', branchId: 'imported-branch', role: 'user', content: { text: 'Hello' }, createdAt: now, runId: null })
  db.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run', 'imported', 'imported-branch', 'input', 'fixture', 'model', 'chat', 'completed', now)
  const invocation = 'INSERT INTO run_change_invocations (id, run_id, segment_id, tool_call_id, tool_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  db.prepare(invocation).run('z-imported-call', 'run', 'segment', 'tool', 'write', 'completed', now)
  db.prepare(invocation).run('a-imported-call', 'run', 'segment', 'tool-2', 'write', 'completed', now)
  db.prepare('UPDATE conversation_public_heads SET sequence = 4 WHERE conversation_id = ?').run('imported')
  db.close()
  const mediaDirectory = conversationImageDirectory(join(source.root, 'buddy/conversations/imported'))
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xQAAAAASUVORK5CYII=', 'base64')
  const image = await new ImageBlobStore(mediaDirectory).put(imageBytes.toString('base64'))
  const sessionDirectory = join(source.root, 'buddy/conversations/imported/session')
  await mkdir(sessionDirectory, { recursive: true })
  const mediaMessage = { role: 'toolResult', toolName: 'read', toolCallId: 'read-image', content: [{ type: 'image', data: '', mimeType: 'image/png' }], buddyToolMedia: { version: 1, images: [{ ...image, contentIndex: 0, mimeType: 'image/png' }] } }
  await writeFile(join(sessionDirectory, 'media.jsonl'), `${JSON.stringify({ type: 'message', message: mediaMessage })}\n`)
  const snapshot = await source.snapshot(['tasks'])
  const target = await fixture()
  const current = target.database()
  current.prepare('UPDATE buddies SET name = ? WHERE id = ?').run('My current buddy', 'default')
  createConversationRepository(current).create({ id: 'retained', branchId: 'retained-branch', title: 'Retained task', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  current.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('retained-run', 'retained', 'retained-branch', 'retained-input', 'fixture', 'model', 'chat', 'completed', now)
  current.prepare(invocation).run('retained-call', 'retained-run', 'segment', 'tool', 'write', 'completed', now)
  current.close()
  await copySnapshot(snapshotDirectory(source.root, snapshot.id), snapshotDirectory(target.root, snapshot.id), { signal, report, privateDirectoriesExecutable })
  await target.store.request('restore', target.root, [], snapshot.id, ['tasks'])
  await target.run()
  const restoredMedia = new ImageBlobStore(conversationImageDirectory(join(target.root, 'buddy/conversations/imported')))
  expect(await restoredMedia.read(image)).toEqual(imageBytes)
  expect(JSON.parse(await readFile(join(target.root, 'buddy/conversations/imported/session/media.jsonl'), 'utf8')).message).toEqual(mediaMessage)
  const result = target.database()
  expect(result.prepare('SELECT id FROM conversations ORDER BY id').all()).toEqual([{ id: 'imported' }, { id: 'retained' }])
  expect(result.prepare('SELECT COUNT(*) AS count FROM conversation_publications').get()?.count).toBe(1)
  expect(result.prepare('SELECT COUNT(*) AS count FROM execution_state').get()?.count).toBe(2)
  expect(result.prepare('SELECT id, sequence FROM run_change_invocations ORDER BY sequence').all()).toEqual([{ id: 'retained-call', sequence: 1 }, { id: 'z-imported-call', sequence: 2 }, { id: 'a-imported-call', sequence: 3 }])
  expect(result.prepare('SELECT name FROM buddies WHERE id = ?').get('default')?.name).toBe('My current buddy')
  expect(result.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  createConversationRepository(result).createMessage({ id: 'after', conversationId: 'imported', branchId: 'imported-branch', role: 'user', content: { text: 'After restore' }, createdAt: now, runId: null })
  expect(result.prepare('SELECT COUNT(*) AS count FROM conversation_publications').get()?.count).toBe(2)
  expect(result.prepare('SELECT sequence FROM conversation_public_heads WHERE conversation_id = ?').get('imported')?.sequence).toBe(5)
  result.close()
  await target.store.request('restore', target.root, [], snapshot.id, ['tasks'])
  await target.run()
  const repeated = target.database()
  expect(repeated.prepare('SELECT id, sequence FROM run_change_invocations ORDER BY sequence').all()).toEqual([{ id: 'retained-call', sequence: 1 }, { id: 'z-imported-call', sequence: 2 }, { id: 'a-imported-call', sequence: 3 }])
  expect(repeated.prepare('SELECT sequence FROM conversation_public_heads WHERE conversation_id = ?').get('imported')?.sequence).toBe(5)
  repeated.close()
})
it('keeps newer task publications writable after restoring an older backup', async () => {
  const f = await fixture()
  let db = f.database()
  createConversationRepository(db).create({ id: 'task', branchId: 'branch', title: 'Task', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  const add = (database: typeof db, id: string) => createConversationRepository(database).createMessage({ id, conversationId: 'task', branchId: 'branch', role: 'user', content: { text: id }, createdAt: now, runId: null })
  add(db, 'before')
  db.close()
  const snapshot = await f.snapshot(['tasks'])
  db = f.database()
  add(db, 'newer')
  db.close()
  await f.store.request('restore', f.root, [], snapshot.id, ['tasks'])
  await f.run()
  db = f.database()
  add(db, 'after')
  expect(db.prepare('SELECT sequence FROM conversation_publications ORDER BY sequence').all()).toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }])
  expect(db.prepare('SELECT sequence FROM conversation_public_heads').get()?.sequence).toBe(3)
  db.close()
})
it('preserves the selected cloud target when restoring connection records', async () => {
  const f = await fixture()
  const webdav = { id: randomUUID(), credentialId: randomUUID(), adapter: 'webdav', name: 'Fixture', endpoint: 'https://example.invalid', username: 'fixture' }
  const s3 = { id: randomUUID(), credentialId: randomUUID(), adapter: 's3', name: 'Fixture S3', endpoint: 'https://example.invalid', bucket: 'fixture-bucket', region: 'auto', prefix: 'backup', accessKeyId: 'fixture', pathStyle: true }
  const path = join(f.root, 'device/sync.json')
  await writeStorageJson(path, { version: 1, enabled: true, selectedAdapter: 'webdav', activeConnectionId: webdav.id, connections: [webdav, s3] })
  const snapshot = await f.snapshot(['connections'])
  await writeStorageJson(path, { version: 1, enabled: true, selectedAdapter: 's3', activeConnectionId: s3.id, connections: [webdav, s3] })
  await f.store.request('restore', f.root, [], snapshot.id, ['connections'])
  await f.run()
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: true, selectedAdapter: 's3', activeConnectionId: s3.id, connections: [webdav, s3] })
})
it('discards only owned candidate files and credential staging when cancelling a restore', async () => {
  const f = await fixture()
  const snapshot = await f.snapshot(['settings'])
  const operation = (await f.store.request('restore', f.root, [], snapshot.id, ['settings'])).pending!
  const controller = new AbortController()
  await expect(runStorageMigration({ locationPath: f.store.path, defaultRoot: f.root, legacySources: [], privateDirectoriesExecutable }, controller.signal, (progress) => {
    if (progress.phase === 'copying')
      controller.abort()
  })).rejects.toThrow('STORAGE_CANCELLED')
  const credentialStage = restoreCredentialStage(f.store.path, operation.id)
  await writeStorageJson(join(credentialStage, 'fixture.json'), { synthetic: true })
  await f.store.cancel()
  await expect(readFile(join(restoreStage(operation), '.storage-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(credentialStage, 'fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.store.read()).pending).toBeNull()
  expect((await verifyStorageSnapshot(snapshotDirectory(f.root, snapshot.id), signal)).id).toBe(snapshot.id)
  const next = (await f.store.request('restore', f.root, [], snapshot.id, ['settings'])).pending!
  await writeStorageJson(join(restoreStage(next), '.storage-owner.json'), { id: randomUUID() })
  await expect(f.store.cancel()).rejects.toThrow('STORAGE_STAGE_NOT_OWNED')
  expect((await f.store.read()).pending?.id).toBe(next.id)
})
it('backs up workspace files with minimal owner metadata, without task messages or providers', async () => {
  const f = await fixture()
  const db = f.database()
  const conversations = createConversationRepository(db)
  conversations.create({ id: 'owner', branchId: 'branch', title: 'Owner', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  conversations.createMessage({ id: 'input', conversationId: 'owner', branchId: 'branch', role: 'user', content: { text: 'Not selected' }, createdAt: now, runId: null })
  db.close()
  await mkdir(join(f.root, 'buddy/conversations/owner/workspace'), { recursive: true })
  await writeFile(join(f.root, 'buddy/conversations/owner/workspace/result.txt'), 'workspace result')
  const snapshot = await f.snapshot(['workspaces'])
  const extracted = join(f.directory, 'workspace-backup')
  await extractSnapshotFiles(snapshotDirectory(f.root, snapshot.id), extracted, snapshot, { signal, report, privateDirectoriesExecutable })
  const backup = openBuddyDatabase({ databasePath: join(extracted, 'buddy/buddy.sqlite3') })
  expect(backup.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'owner' }])
  expect(backup.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0)
  expect(backup.prepare('SELECT id FROM conversation_branches').all()).toEqual([{ id: 'branch' }])
  expect(backup.prepare('SELECT actor_id FROM conversation_members').all()).toEqual([{ actor_id: 'default' }])
  expect(backup.prepare('SELECT COUNT(*) AS count FROM provider_states').get()?.count).toBe(0)
  expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  backup.close()
  expect(snapshot.files.some(entry => entry.path.endsWith('result.txt'))).toBe(true)
  const target = await fixture()
  await copySnapshot(snapshotDirectory(f.root, snapshot.id), snapshotDirectory(target.root, snapshot.id), { signal, report, privateDirectoriesExecutable })
  await target.store.request('restore', target.root, [], snapshot.id, ['workspaces'])
  await target.run()
  const restored = target.database()
  expect(createConversationRepository(restored).findById('owner')?.activeBranchId).toBe('branch')
  expect(restored.prepare('SELECT actor_id FROM conversation_members').all()).toEqual([{ actor_id: 'default' }])
  restored.close()
  expect(await readFile(join(target.root, 'buddy/conversations/owner/workspace/result.txt'), 'utf8')).toBe('workspace result')
})
it('resumes an interrupted in-place replacement and preserves original settings and plugin data for recovery', async () => {
  const f = await fixture()
  const manifest = extensionManifestSchema.parse({ schemaVersion: 1, id: 'test.plugin', name: 'Fixture', version: '1.0.0', apiVersion: 3, engines: { lexora: '^0.11.0' }, entry: 'extension.js', contributes: {} })
  await writeStorageJson(join(f.root, 'buddy/extensions/installed.json'), { version: 1, installed: { 'test.plugin': { current: { manifest, revision: 'a'.repeat(64), hashes: {}, source: null }, enabled: true, pending: null, development: false } } })
  await writeStorageJson(join(f.root, 'buddy/extensions/schedules.json'), { version: 1, jobs: [{ extensionId: 'test.plugin', id: 'reminder', command: 'test.plugin.remind', enabled: true, intervalMinutes: 5, nextRunAt: 1800000000000 }] })
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), { value: 'backup' })
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "zh-CN"\nlaunch_at_login = false\n[desktop.profile]\nuser_name = "Restored name"\ndevice_name = "Source machine"\n')
  const assetKey = 'b'.repeat(64)
  const privateFile = `buddy/extensions/data/test.plugin/files/${assetKey}`
  const themeFile = `buddy/themes/assets/${assetKey}`
  for (const path of [privateFile, themeFile]) {
    await mkdir(join(f.root, path, '..'), { recursive: true })
    await writeFile(join(f.root, path), 'backed up image')
  }
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/owned-resources.json'), [{ resource: { id: randomUUID(), name: 'image.png', mimeType: 'image/png', size: 15 }, key: assetKey }])
  await writeStorageJson(join(f.root, 'buddy/themes/user-themes.json'), { version: 2, themes: {} })
  const snapshot = await f.snapshot(['plugins', 'settings'])
  for (const path of [privateFile, themeFile])
    await writeFile(join(f.root, path), 'current image')
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), { value: 'current' })
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/resources/grant.json'), { path: 'fixture-only' })
  await writeStorageJson(join(f.root, 'buddy/extensions/data/test.plugin/local-directories.json'), [{ path: 'fixture-only' }])
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "en-US"\nlaunch_at_login = true\n[desktop.profile]\ndevice_name = "Current machine"\n')
  const requested = await f.store.request('restore', f.root, [], snapshot.id, ['plugins', 'settings'])
  const operation = requested.pending!
  await f.store.checkpoint(operation, 'copying')
  await prepareBackupRestore(operation, restoreStage(operation), f.store.path, signal, report, privateDirectoriesExecutable)
  await prepareRestoreCommit(operation)
  await f.store.checkpoint(operation, 'ready')
  await mkdir(restoreRetained(operation), { recursive: true })
  await rename(join(f.root, 'buddy'), join(restoreRetained(operation), 'buddy'))
  await f.run()
  expect(await f.store.read()).toMatchObject({ activeRoot: f.root, pending: null })
  expect(JSON.parse(await readFile(join(f.root, 'buddy/extensions/data/test.plugin/state.json'), 'utf8'))).toEqual({ value: 'backup' })
  for (const path of [privateFile, themeFile]) {
    expect(await readFile(join(f.root, path), 'utf8')).toBe('backed up image')
    expect(await readFile(join(restoreRetained(operation), path), 'utf8')).toBe('current image')
  }
  expect(JSON.parse(await readFile(join(f.root, 'buddy/extensions/data/test.plugin/owned-resources.json'), 'utf8'))[0].key).toBe(assetKey)
  expect(JSON.parse(await readFile(join(f.root, 'buddy/themes/user-themes.json'), 'utf8')).version).toBe(2)
  expect(JSON.parse(await readFile(join(f.root, 'buddy/extensions/installed.json'), 'utf8')).installed['test.plugin'].enabled).toBe(false)
  expect(JSON.parse(await readFile(join(f.root, 'buddy/extensions/schedules.json'), 'utf8')).jobs).toEqual([{ extensionId: 'test.plugin', id: 'reminder', command: 'test.plugin.remind', enabled: false, intervalMinutes: 5, nextRunAt: null }])
  await expect(readFile(join(f.root, 'buddy/extensions/data/test.plugin/resources/grant.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.root, 'buddy/extensions/data/test.plugin/local-directories.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(parse(await readFile(join(f.root, 'config.toml'), 'utf8'))).toMatchObject({ desktop: { language: 'zh-CN', launch_at_login: true, profile: { user_name: 'Restored name', device_name: 'Current machine' } } })
  expect(JSON.parse(await readFile(join(restoreRetained(operation), 'buddy/extensions/data/test.plugin/state.json'), 'utf8'))).toEqual({ value: 'current' })
  await expect(readFile(join(restoreStage(operation), 'commit.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('finishes a committed restore after interruption before locator activation', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "zh-CN"\n')
  const snapshot = await f.snapshot(['settings'])
  await writeFile(join(f.root, 'config.toml'), '[desktop]\nlanguage = "en-US"\n')
  await f.store.request('restore', f.root, [], snapshot.id, ['settings'])
  const activate = vi.spyOn(StorageLocationStore.prototype, 'activate').mockRejectedValueOnce(new Error('STORAGE_FIXTURE_INTERRUPTED'))
  await expect(f.run()).rejects.toThrow('STORAGE_FIXTURE_INTERRUPTED')
  activate.mockRestore()
  expect((await f.store.read()).pending?.phase).toBe('ready')
  await expect(f.store.cancel()).rejects.toThrow('STORAGE_COMMITTING')
  await f.run()
  expect((await f.store.read()).pending).toBeNull()
  expect(await readFile(join(f.root, 'config.toml'), 'utf8')).toContain('zh-CN')
})
