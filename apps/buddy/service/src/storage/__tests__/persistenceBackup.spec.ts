import type { BackupScope } from '../../../../shared/storage/backupScope'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copySnapshot } from '../../../../platform/storage/copySnapshot'
import { extractSnapshotFiles } from '../../../../platform/storage/extractSnapshotFiles'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { deviceBearer } from '../../../../shared/privateNetwork/pairing'
import { DeviceAuthorizationService } from '../../privateNetwork/DeviceAuthorizationService'
import { createAttachmentPersistenceRepository } from '../attachmentPersistenceRepository'
import { createAttachmentRepository } from '../attachmentRepository'
import { CommandCommitter } from '../CommandCommitter'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../database'
import { prepareBackupRestore } from '../restoreBackup'
import { BUDDY_MIGRATION_SCHEMA_VERSION } from '../schema'
import { openSnapshotDatabase, rewriteIsolatedSnapshotDatabase } from '../snapshotDatabase'
import { createStorageSnapshot, snapshotDirectory } from '../StorageSnapshots'

const directories: string[] = []
const signal = new AbortController().signal
const now = '2026-11-07T00:00:00.000Z'
function report() {}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-persistence-backup-'))
  directories.push(directory)
  const root = join(directory, 'profile')
  await mkdir(join(root, 'buddy'), { recursive: true })
  const path = join(root, 'buddy/buddy.sqlite3')
  const database = legacy ? openBuddyDatabase({ databasePath: path }) : openBuddyMigrationCandidate({ databasePath: path })
  if (!legacy)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  database.close()
  return { root, path, directory, open: () => openSnapshotDatabase(path), snapshot: (scopes: BackupScope[]) => createStorageSnapshot(root, randomUUID(), signal, report, undefined, { scopes, credentials: false }) }
}
function seedDraft(database: ReturnType<typeof openSnapshotDatabase>, id: string) {
  return createComposerDraftRepository(database).open({ draftId: id, scope: { kind: 'task', draftId: id, spaceId: null }, initialContent: createBuddyUserContent('Keep this draft'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null, now })
}
function receipt(database: ReturnType<typeof openSnapshotDatabase>) {
  const generation = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  return new CommandCommitter(database).accept({ dataGeneration: generation, actorId: 'desktop-local', commandId: 'receipt', method: 'composerDrafts.save', fingerprint: 'fingerprint', fingerprintVersion: 1, sourceInstanceId: 'old-instance' }, () => ({ target: { draftId: 'saved-draft' }, result: { revision: 1 } })).receipt
}

describe('sQLite authority snapshot compatibility', () => {
  it('preserves autoincrement high water marks above JavaScript safe integers after deleted history', async () => {
    const f = await fixture()
    const source = f.open()
    source.exec('CREATE TABLE retained_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); INSERT INTO retained_sequence (id, value) VALUES (9007199254740993, \'deleted history\'); DELETE FROM retained_sequence')
    source.close()
    await rewriteIsolatedSnapshotDatabase(f.path, () => {})
    const rewritten = f.open()
    try {
      rewritten.exec('INSERT INTO retained_sequence (value) VALUES (\'new record\')')
      const statement = rewritten.prepare('SELECT id FROM retained_sequence')
      statement.setReadBigInts(true)
      expect(statement.get()?.id).toBe(9007199254740994n)
    }
    finally { rewritten.close() }
  })

  it('exports a selective snapshot with permanent receipts and valid identity while preserving source bytes and constraints', async () => {
    const f = await fixture()
    const source = f.open()
    const original = receipt(source)
    seedDraft(source, 'draft')
    source.close()
    const before = await readFile(f.path)
    const manifest = await f.snapshot(['providers'])
    expect(manifest.databaseVersion).toBe(BUDDY_MIGRATION_SCHEMA_VERSION)
    expect(await readFile(f.path)).toEqual(before)
    const extracted = join(f.directory, 'extracted')
    await extractSnapshotFiles(snapshotDirectory(f.root, manifest.id), extracted, manifest, { signal, report })
    const saved = openSnapshotDatabase(join(extracted, 'buddy/buddy.sqlite3'))
    try {
      expect(saved.prepare('SELECT * FROM composer_drafts').all()).toEqual([])
      expect(saved.prepare('SELECT * FROM managed_files').all()).toEqual([])
      expect(new CommandCommitter(saved).find(original)).toEqual(original)
      expect(saved.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => saved.exec('DELETE FROM command_receipts')).toThrow('IMMUTABLE')
    }
    finally { saved.close() }
  })

  it('restores files, ownership and receipts into an isolated new generation without reactivating devices', async () => {
    const from = await fixture()
    const source = from.open()
    const original = receipt(source)
    seedDraft(source, 'saved-draft')
    const file = join(from.root, 'buddy/drafts/saved-draft/file.txt')
    await mkdir(join(from.root, 'buddy/drafts/saved-draft'), { recursive: true })
    await writeFile(file, 'fixture')
    createAttachmentPersistenceRepository(source).adopt({ path: file, sizeBytes: 7, sha256: createHash('sha256').update('fixture').digest('hex') })
    createAttachmentRepository(source).create({ id: 'attachment', draftId: 'saved-draft', messageId: null, conversationId: null, name: 'file.txt', mimeType: 'text/plain', sizeBytes: 7, storedPath: file, createdAt: now })
    source.close()
    const snapshot = await from.snapshot(['tasks'])
    const to = await fixture()
    const current = to.open()
    seedDraft(current, 'unrelated-draft')
    current.exec('INSERT INTO storage_actors VALUES (\'device\', \'device\', \'active\', \'2026-11-07T00:00:00.000Z\')')
    const devices = new DeviceAuthorizationService({ database: current, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'before' })
    const qr = devices.issue('https://127.0.0.1:9443', `sha256/${'A'.repeat(43)}=`)
    const { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret } = qr
    const context = { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret }
    const attempt = devices.prepare({ ...context, deviceName: 'Restore fixture' })
    const credential = devices.redeem({ ...context, attemptId: attempt.attemptId, recoverySecret: attempt.recoverySecret })
    devices.confirm(deviceBearer(credential))
    current.prepare('UPDATE private_network_state SET tls_pin = ? WHERE id = 1').run(qr.spkiPin)

    const oldGeneration = current.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation
    current.close()
    await copySnapshot(snapshotDirectory(from.root, snapshot.id), snapshotDirectory(to.root, snapshot.id), { signal, report })
    const stage = join(to.directory, 'restore')
    await prepareBackupRestore({ id: randomUUID(), kind: 'restore', source: to.root, target: to.root, phase: 'pending', createdAt: now, error: null, snapshotId: snapshot.id, scopes: ['tasks'], credentials: false }, stage, join(to.directory, 'location.json'), signal, report)
    const restored = openSnapshotDatabase(join(stage, 'profile/buddy/buddy.sqlite3'))
    try {
      const newGeneration = restored.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation
      expect(newGeneration).not.toBe(oldGeneration)
      expect(newGeneration).not.toBe(original.dataGeneration)
      expect(restored.prepare('SELECT state FROM storage_actors WHERE id = \'device\'').get()).toEqual({ state: 'revoked' })
      expect(restored.prepare('SELECT state, grant_generation FROM remote_devices WHERE id = ?').get(credential.deviceId)).toEqual({ state: 'revoked', grant_generation: 2 })
      expect(restored.prepare('SELECT tls_pin FROM private_network_state WHERE id = 1').get()!.tls_pin).toBe(qr.spkiPin)
      const restoredDevices = new DeviceAuthorizationService({ database: restored, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'after' })
      expect(() => restoredDevices.authenticate(deviceBearer(credential))).toThrow('NOT_AUTHORIZED')

      expect(restored.prepare('SELECT id, owner_actor_id FROM composer_drafts ORDER BY id').all()).toEqual([{ id: 'saved-draft', owner_actor_id: 'desktop-local' }, { id: 'unrelated-draft', owner_actor_id: 'desktop-local' }])
      expect(restored.prepare('SELECT data_generation, command_id FROM command_receipts').get()).toEqual({ data_generation: original.dataGeneration, command_id: 'receipt' })
      const stored = String(restored.prepare('SELECT path FROM managed_files').get()!.path)
      expect(stored).toBe(join(to.root, 'buddy/drafts/saved-draft/file.txt'))
      expect(await readFile(join(stage, 'profile/buddy/drafts/saved-draft/file.txt'), 'utf8')).toBe('fixture')
      expect(() => restored.exec('DELETE FROM managed_files')).toThrow('IMMUTABLE')
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally { restored.close() }
    const untouched = to.open()
    expect(untouched.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation).toBe(oldGeneration)
    untouched.close()
  })

  it('converts a legacy selective snapshot through full source verification before merging into SQLite authority', async () => {
    const legacy = await fixture(true)
    const source = legacy.open()
    source.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)').run('fixture-provider', now, now)
    source.close()
    const snapshot = await legacy.snapshot(['providers'])
    const to = await fixture()
    await copySnapshot(snapshotDirectory(legacy.root, snapshot.id), snapshotDirectory(to.root, snapshot.id), { signal, report })
    const stage = join(to.directory, 'restore')
    await prepareBackupRestore({ id: randomUUID(), kind: 'restore', source: to.root, target: to.root, phase: 'pending', createdAt: now, error: null, snapshotId: snapshot.id, scopes: ['providers'], credentials: false }, stage, join(to.directory, 'location.json'), signal, report)
    const restored = openSnapshotDatabase(join(stage, 'profile/buddy/buddy.sqlite3'))
    expect(restored.prepare('SELECT enabled FROM provider_states WHERE provider_id = ?').get('fixture-provider')).toEqual({ enabled: 1 })
    expect(restored.prepare('SELECT authority, migration_state FROM storage_profile').get()).toEqual({ authority: 'sqlite', migration_state: 'ready' })
    restored.close()
    const original = legacy.open()
    expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: 42 })
    original.close()
  })
  it('upgrades an isolated legacy target when restoring a SQLite snapshot and leaves the original target unchanged', async () => {
    const from = await fixture()
    const source = from.open()
    receipt(source)
    source.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)').run('candidate-provider', now, now)
    source.close()
    const snapshot = await from.snapshot(['providers'])
    const to = await fixture(true)
    const before = await readFile(to.path)
    await copySnapshot(snapshotDirectory(from.root, snapshot.id), snapshotDirectory(to.root, snapshot.id), { signal, report })
    const stage = join(to.directory, 'restore')
    await prepareBackupRestore({ id: randomUUID(), kind: 'restore', source: to.root, target: to.root, phase: 'pending', createdAt: now, error: null, snapshotId: snapshot.id, scopes: ['providers'], credentials: false }, stage, join(to.directory, 'location.json'), signal, report)
    const restored = openSnapshotDatabase(join(stage, 'profile/buddy/buddy.sqlite3'))
    expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_MIGRATION_SCHEMA_VERSION })
    expect(restored.prepare('SELECT command_id FROM command_receipts').all()).toEqual([{ command_id: 'receipt' }])
    restored.close()
    expect(await readFile(to.path)).toEqual(before)
  })

  it('rejects conflicting immutable receipt identities without altering the current profile', async () => {
    const from = await fixture()
    const source = from.open()
    const original = receipt(source)
    source.close()
    const snapshot = await from.snapshot(['providers'])
    const to = await fixture()
    const current = to.open()
    current.prepare('UPDATE storage_profile SET data_generation = ?').run(original.dataGeneration)
    new CommandCommitter(current).accept({ dataGeneration: original.dataGeneration, actorId: original.actorId, commandId: original.commandId, method: original.method, fingerprint: original.fingerprint, fingerprintVersion: original.fingerprintVersion, sourceInstanceId: original.sourceInstanceId }, () => ({ target: { draftId: 'different-target' }, result: { revision: 1 } }))
    current.close()
    const before = await readFile(to.path)
    await copySnapshot(snapshotDirectory(from.root, snapshot.id), snapshotDirectory(to.root, snapshot.id), { signal, report })
    await expect(prepareBackupRestore({ id: randomUUID(), kind: 'restore', source: to.root, target: to.root, phase: 'pending', createdAt: now, error: null, snapshotId: snapshot.id, scopes: ['providers'], credentials: false }, join(to.directory, 'restore'), join(to.directory, 'location.json'), signal, report)).rejects.toThrow('SNAPSHOT_DEPENDENCY_CONFLICT')
    expect(await readFile(to.path)).toEqual(before)
  })
})
