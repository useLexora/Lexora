import type { CredentialVault } from '../../secrets/CredentialVault'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { backupScopes } from '../../../../shared/storage/backupScope'
import { nextBackupTime } from '../../../../shared/sync/backupSchedule'
import { BackupScheduler } from '../BackupScheduler'

async function fixture() {
  const root = await createTemporaryDirectory('lexora-scheduler-')
  const connectionId = randomUUID()
  const created: string[] = []
  const uploaded: string[] = []
  const values = new Map<string, unknown>()
  const vault: CredentialVault = {
    read: async (_, id) => values.get(id) ?? null,
    write: async (_, id, value) => { values.set(id, value) },
    delete: async (_, id) => { values.delete(id) },
    listProviders: async () => [],
  }
  let selected: string | null = connectionId
  let enabled = true
  let idle = true
  let online = false
  const hub = {
    state: () => ({ enabled, selectedAdapter: 'webdav' as const, activeConnectionId: selected, activity: null, schedules: [], scheduleError: false, connections: [{ id: connectionId, adapter: 'webdav' as const, name: 'fixture', endpoint: 'https://example.invalid', username: 'fixture' }] }),
    run: async (_action: string, _connectionId: string, id?: string) => {
      if (!online)
        throw new Error('SYNC_FAILED')
      uploaded.push(id!)
    },
  }
  const backups = {
    busy: false,
    run: async <T>(action: () => Promise<T>) => action(),
    prune: async () => {},
    create: async () => {
      if (!idle)
        throw new Error('SNAPSHOT_RUNTIME_BUSY')
      const id = randomUUID()
      created.push(id)
      return { id, scopes: [...backupScopes], credentials: false, createdAt: new Date().toISOString(), files: 1, bytes: 1, excludedLinks: 0 }
    },
  }
  const scheduler = () => new BackupScheduler(root, backups, hub, vault, () => {})
  const policy = { frequency: 'daily' as const, time: '20:00', weekday: 0, scopes: [...backupScopes], credentials: false }
  return {
    root,
    connectionId,
    policy,
    scheduler,
    created,
    uploaded,
    values,
    setSelected(value: string | null) {
      selected = value
    },
    setIdle(value: boolean) {
      idle = value
    },
    setOnline(value: boolean) {
      online = value
    },
    setEnabled(value: boolean) {
      enabled = value
    },
  }
}

it('defers busy tasks, persists the failed upload, and retries the same snapshot after restart', async () => {
  const f = await fixture()
  let scheduler = f.scheduler()
  await scheduler.initialize()
  await scheduler.save(f.connectionId, f.policy, new Date('2026-10-14T00:00:00Z'))
  const due = new Date(scheduler.state()[0]!.nextRunAt!)
  f.setIdle(false)
  await scheduler.tick(due)
  expect(scheduler.state()[0]).toMatchObject({ status: 'waiting', error: null })
  expect(f.created).toEqual([])
  f.setIdle(true)
  const attempt = new Date(due.getTime() + 60_000)
  await scheduler.tick(attempt)
  expect(f.created).toHaveLength(1)
  expect(scheduler.protectedSnapshots()).toEqual(new Set(f.created))
  expect(scheduler.state()[0]).toMatchObject({ status: 'failed', lastSuccessAt: null })
  scheduler.dispose()
  const schedulePath = join(f.root, 'device/backup-schedules.json')
  const legacy = JSON.parse(await readFile(schedulePath, 'utf8'))
  legacy.records[0].policy.localKeep = 1
  legacy.records[0].policy.remoteKeep = 1
  await writeFile(schedulePath, JSON.stringify(legacy))
  scheduler = f.scheduler()
  await scheduler.initialize()
  f.setOnline(true)
  const retry = new Date(attempt.getTime() + 300_000)
  await scheduler.tick(retry)
  expect(f.created).toHaveLength(1)
  expect(f.uploaded).toEqual(f.created)
  expect(scheduler.protectedSnapshots().size).toBe(0)
  expect(scheduler.state()[0]).toMatchObject({ status: 'idle', lastSuccessAt: retry.toISOString(), error: null })
  await scheduler.tick(retry)
  expect(f.uploaded).toHaveLength(1)
  expect(JSON.parse(await readFile(join(f.root, 'device/backup-schedules.json'), 'utf8')).records[0].pendingId).toBeNull()
})

it('runs only the enabled selected target and catches up once after multiple missed days', async () => {
  const f = await fixture()
  const scheduler = f.scheduler()
  await scheduler.initialize()
  await scheduler.save(f.connectionId, f.policy, new Date('2026-10-01T00:00:00Z'))
  f.setEnabled(false)
  f.setOnline(true)
  const now = new Date('2026-10-14T23:00:00Z')
  await scheduler.tick(now)
  expect(f.created).toHaveLength(0)
  f.setEnabled(true)
  f.setSelected(null)
  await scheduler.tick(now)
  expect(f.created).toHaveLength(0)
  f.setSelected(f.connectionId)
  await scheduler.tick(now)
  await scheduler.tick(now)
  expect(f.created).toHaveLength(1)
  await scheduler.save(f.connectionId, { ...f.policy, frequency: 'manual' }, now)
  await scheduler.tick(new Date('2026-11-01T00:00:00Z'))
  expect(f.created).toHaveLength(1)
})

it('stores the automatic backup password only in the credential vault and keeps it on policy edits', async () => {
  const f = await fixture()
  const scheduler = f.scheduler()
  await scheduler.initialize()
  await expect(scheduler.requestNow(f.connectionId, { scopes: ['providers'], credentials: true }, 'weekly')).rejects.toThrow('BACKUP_PASSWORD_REQUIRED')
  expect(scheduler.state()).toEqual([])
  await scheduler.tick()
  expect(f.created).toHaveLength(0)
  await scheduler.save(f.connectionId, { ...f.policy, credentials: true, password: 'fixture-encryption-password' })
  await scheduler.save(f.connectionId, { ...f.policy, credentials: true, frequency: 'weekly' })
  expect([...f.values.values()]).toEqual(['fixture-encryption-password'])
  expect(await readFile(join(f.root, 'device/backup-schedules.json'), 'utf8')).not.toContain('fixture-encryption-password')
  expect(JSON.stringify(scheduler.state())).not.toContain('credentialId')
  await scheduler.save(f.connectionId, { ...f.policy, credentials: false })
  expect(f.values.size).toBe(0)
})

it('advances hourly and weekly schedules beyond the current occurrence using local calendar time', () => {
  const policy = { frequency: 'weekly' as const, time: '20:00', weekday: 3, scopes: [...backupScopes], credentials: false }
  const due = new Date(2026, 9, 14, 20, 0)
  expect(new Date(nextBackupTime(policy, due)!).getTime()).toBe(new Date(2026, 9, 21, 20, 0).getTime())
  expect(new Date(nextBackupTime({ ...policy, frequency: 'hourly' }, due)!).getTime()).toBe(new Date(2026, 9, 14, 21, 0).getTime())
  expect(nextBackupTime({ ...policy, frequency: 'manual' }, due)).toBeNull()
})

it('saves a first backup with its chosen frequency and runs it once without a prior default backup', async () => {
  const f = await fixture()
  const scheduler = f.scheduler()
  await scheduler.initialize()
  f.setOnline(true)
  await scheduler.requestNow(f.connectionId, { scopes: ['tasks'], credentials: false }, 'weekly')
  expect(scheduler.state()[0]).toMatchObject({ status: 'waiting', policy: { frequency: 'weekly', scopes: ['tasks'] } })
  await scheduler.tick()
  await scheduler.tick()
  expect(f.uploaded).toEqual(f.created)
  expect(f.created).toHaveLength(1)
  await scheduler.setFrequency(f.connectionId, 'hourly')
  await scheduler.tick()
  expect(f.created).toHaveLength(1)
  const restarted = f.scheduler()
  await restarted.initialize()
  expect(restarted.state()[0]?.policy.frequency).toBe('hourly')
})

it('keeps a future schedule when switching back and advances an overdue schedule without backing up', async () => {
  const f = await fixture()
  const scheduler = f.scheduler()
  await scheduler.initialize()
  f.setOnline(true)
  const now = new Date('2026-10-14T10:15:00Z')
  await scheduler.activate(f.connectionId, { immediate: false, now })
  const next = scheduler.state()[0]!.nextRunAt!
  expect(Date.parse(next)).toBeGreaterThan(now.getTime())
  await scheduler.tick(now)
  expect(f.created).toEqual([])
  await scheduler.activate(f.connectionId, { immediate: false, now: new Date(now.getTime() + 60_000) })
  expect(scheduler.state()[0]?.nextRunAt).toBe(next)
  const overdue = new Date(Date.parse(next) + 60_000)
  await scheduler.activate(f.connectionId, { immediate: false, now: overdue })
  const rescheduled = scheduler.state()[0]!.nextRunAt!
  expect(rescheduled).toBe(nextBackupTime(scheduler.state()[0]!.policy, overdue))
  await scheduler.tick(overdue)
  expect(f.created).toEqual([])
  const restarted = f.scheduler()
  await restarted.initialize()
  expect(restarted.state()[0]?.nextRunAt).toBe(rescheduled)
  await restarted.tick(new Date(rescheduled))
  expect(f.uploaded).toEqual(f.created)
  expect(f.created).toHaveLength(1)
})

it('defers a failed upload when switching back while preserving its pending snapshot', async () => {
  const f = await fixture()
  const scheduler = f.scheduler()
  await scheduler.initialize()
  const now = new Date('2026-10-14T10:15:00Z')
  await scheduler.activate(f.connectionId, { now })
  expect(scheduler.state()[0]?.nextRunAt).toBe(now.toISOString())
  await scheduler.tick(now)
  expect(scheduler.state()[0]?.status).toBe('failed')
  const pending = scheduler.protectedSnapshots()
  await scheduler.activate(f.connectionId, { immediate: false, now })
  expect(scheduler.state()[0]).toMatchObject({ status: 'idle', retryAt: null, error: null })
  expect(scheduler.protectedSnapshots()).toEqual(pending)
  f.setOnline(true)
  await scheduler.tick(now)
  expect(f.uploaded).toEqual([])
  await scheduler.tick(new Date(scheduler.state()[0]!.nextRunAt!))
  expect(f.created).toHaveLength(1)
  expect(f.uploaded).toEqual([...pending])
})
