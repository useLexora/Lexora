import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { resolveBuddyPrivateDirectories } from '../../../../platform/native/nativeHost'
import { extractSnapshotFiles } from '../../../../platform/storage/extractSnapshotFiles'
import { writeStorageJson } from '../../../../platform/storage/storageFiles'
import { StorageLocationStore } from '../../../../platform/storage/StorageLocationStore'
import { AutomationService } from '../../automations/AutomationService'
import { createAutomationRepositories } from '../automationRepository'
import { openBuddyDatabase } from '../database'
import { runStorageMigration } from '../StorageMigration'
import { createStorageSnapshot, snapshotDirectory, verifyStorageSnapshot } from '../StorageSnapshots'

const privateDirectoriesExecutable = resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false })
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
it('creates portable snapshots without credentials or recursive backups and restores in place with a recovery copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-snapshot-'))
  directories.push(directory)
  const root = join(directory, 'original')
  const identity = { version: 1 as const, layoutVersion: 1 as const, dataId: randomUUID(), generation: randomUUID() }
  await writeStorageJson(join(root, 'storage.json'), identity)
  await mkdir(join(root, 'buddy', 'conversations', 'fixture', 'workspace'), { recursive: true })
  const asset = 'buddy/conversations/fixture/workspace/result.txt'
  await writeFile(join(root, asset), 'result')
  await writeStorageJson(join(root, 'buddy', 'secrets', 'fixture.json'), { value: 'synthetic-secret' })
  await writeStorageJson(join(root, 'device', 'fixture.json'), { browser: 'synthetic-session' })
  const external = join(directory, 'external.txt')
  await writeFile(external, 'external-private')
  await symlink(external, join(root, 'buddy', 'conversations', 'fixture', 'workspace', 'link'))
  const database = openBuddyDatabase({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  database.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at, request_headers_json) VALUES (?, 1, ?, ?, ?)').run('fixture', 'now', 'now', '[{"name":"Authorization","value":"synthetic-token"}]')
  const automations = new AutomationService({ repositories: createAutomationRepositories(database) })
  const automation = automations.create({ requestId: randomUUID(), draft: { executionProfile: 'workspace_write', model: { mode: 'default' }, name: 'Fixture', spaceId: null, prompt: 'Fixture task', timing: { activeFrom: null, activeUntil: null, schedule: { cadence: 'daily', kind: 'calendar', localTime: '09:30' }, timezone: 'UTC' } } })
  const occurrence = automations.runNow({ automationId: automation.id, expectedRevision: 1, requestId: randomUUID() }).occurrence
  database.prepare('UPDATE automation_occurrences SET lease_owner = ?, lease_expires_at = ? WHERE id = ?').run('old-scheduler', '2099-01-01T00:00:00Z', occurrence.id)
  database.close()
  const signal = new AbortController().signal
  const snapshot = await createStorageSnapshot(root, identity.dataId, signal, () => { }, privateDirectoriesExecutable)
  expect(snapshot.excludedLinks).toBe(1)
  expect(snapshot.files.every(entry => !/secrets|device\/fixture|exports/.test(entry.path))).toBe(true)
  expect(await verifyStorageSnapshot(snapshotDirectory(root, snapshot.id), signal)).toEqual(snapshot)
  const extracted = join(directory, 'snapshot-files')
  await extractSnapshotFiles(snapshotDirectory(root, snapshot.id), extracted, snapshot, { signal, report: () => {}, privateDirectoriesExecutable })
  const copy = openBuddyDatabase({ databasePath: join(extracted, 'buddy', 'buddy.sqlite3') })
  expect(copy.prepare('SELECT request_headers_json FROM provider_states').get()?.request_headers_json).toBe('[]')
  const restoredAutomations = new AutomationService({ repositories: createAutomationRepositories(copy) })
  expect(restoredAutomations.get(automation.id)?.status).toBe('paused')
  expect(restoredAutomations.getOccurrence(occurrence.id)?.status).toBe('cancelled')
  expect(restoredAutomations.leaseQueued({ owner: 'new-scheduler', now: '2100-01-01T00:00:00Z', leaseExpiresAt: '2100-01-01T00:01:00Z', limit: 10 })).toEqual([])
  expect(copy.prepare('SELECT lease_owner, lease_expires_at FROM automation_occurrences WHERE id = ?').get(occurrence.id)).toMatchObject({ lease_owner: null, lease_expires_at: null })
  copy.close()
  const original = openBuddyDatabase({ databasePath: join(root, 'buddy', 'buddy.sqlite3') })
  expect(original.prepare('SELECT status FROM automation_occurrences WHERE id = ?').get(occurrence.id)?.status).toBe('queued')
  original.close()
  const store = new StorageLocationStore(join(directory, 'bootstrap', 'location.json'), root)
  await store.write({ version: 1, activeRoot: root, identity, pending: null, history: [] })
  const target = root
  await writeFile(join(root, asset), 'newer result')
  await store.request('restore', target, [], snapshot.id)
  await runStorageMigration({ locationPath: store.path, defaultRoot: root, leaseDirectory: join(directory, 'locks'), privateDirectoriesExecutable, legacySources: [] }, signal, () => { })
  expect((await store.read()).activeRoot).toBe(target)
  expect(await readFile(join(target, asset), 'utf8')).toBe('result')
  const retained = (await store.read()).history.at(-1)!.retainedTarget!
  expect(await readFile(join(retained, asset), 'utf8')).toBe('newer result')
})
