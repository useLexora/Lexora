import type { BackupOptions } from '../../../shared/storage/backupScope'
import type { BackupScheduleInput, BackupScheduleState } from '../../../shared/sync/backupSchedule'
import type { CredentialVault } from '../secrets/CredentialVault'
import type { StorageBackupService } from '../storage/StorageBackupService'
import type { SyncHub } from './SyncHub'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readStorageJson, writeStorageJson } from '../../../platform/storage/storageFiles'
import { backupScopes } from '../../../shared/storage/backupScope'
import { backupScheduleInputSchema, backupScheduleSchema, nextBackupTime } from '../../../shared/sync/backupSchedule'

const recordSchema = z.object({
  connectionId: z.uuid(),
  automatic: z.uuid(),
  policy: backupScheduleSchema.extend({
    localKeep: z.number().int().min(0).max(365).optional(),
    remoteKeep: z.number().int().min(0).max(365).optional(),
  }).transform(({ localKeep: _localKeep, remoteKeep: _remoteKeep, ...policy }) => policy),
  credentialId: z.uuid().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  retryAt: z.iso.datetime().nullable(),
  pendingId: z.uuid().nullable(),
  error: z.string().nullable(),
  cleanupError: z.boolean(),
  manual: z.boolean().default(false),
}).strict()
const storeSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(32) }).strict()
type ScheduleRecord = z.infer<typeof recordSchema>
type Backups = Pick<StorageBackupService, 'busy' | 'run' | 'create' | 'prune'>
type Hub = Pick<SyncHub, 'state' | 'run'>
function defaultPolicy(now: Date) {
  return {
    frequency: 'daily' as const,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    weekday: now.getDay(),
    scopes: [...backupScopes],
    credentials: false,
  }
}

export class BackupScheduler {
  #records: ScheduleRecord[] = []
  #statuses = new Map<string, BackupScheduleState['status']>()
  #timer?: ReturnType<typeof setInterval>
  #running = false
  #disposed = false
  readonly #path: string
  unavailable = false
  readonly backups: Backups
  readonly hub: Hub
  readonly credentials: CredentialVault
  readonly publish: () => void
  constructor(root: string, backups: Backups, hub: Hub, credentials: CredentialVault, publish: () => void) {
    this.backups = backups
    this.hub = hub
    this.credentials = credentials
    this.publish = publish
    this.#path = join(root, 'device', 'backup-schedules.json')
  }

  async initialize() {
    try {
      const stored = await readStorageJson(this.#path)
      this.#records = stored ? storeSchema.parse(stored).records : []
    }
    catch { this.unavailable = true }
  }

  start() {
    this.#timer = setInterval(() => {
      void this.tick().catch(() => {
        this.unavailable = true
        this.publish()
      })
    }, 60_000)
    this.#timer.unref()
  }

  state(): BackupScheduleState[] {
    return this.#records.map(record => ({
      connectionId: record.connectionId,
      policy: structuredClone(record.policy),
      nextRunAt: record.nextRunAt,
      lastSuccessAt: record.lastSuccessAt,
      retryAt: record.retryAt,
      error: record.error,
      cleanupError: record.cleanupError,
      status: this.#statuses.get(record.connectionId) ?? (record.error ? 'failed' : 'idle'),
    }))
  }

  protectedSnapshots() {
    if (this.unavailable)
      throw new Error('BACKUP_SCHEDULE_UNAVAILABLE')
    return new Set(this.#records.flatMap(record => record.pendingId ? [record.pendingId] : []))
  }

  async #persist() {
    await writeStorageJson(this.#path, { version: 1, records: this.#records })
    this.publish()
  }

  async save(connectionId: string, input: BackupScheduleInput, now = new Date(), immediate = false) {
    if (this.unavailable)
      throw new Error('BACKUP_SCHEDULE_UNAVAILABLE')
    if (!this.hub.state().connections.some(item => item.id === connectionId))
      throw new Error('SYNC_CONNECTION_MISSING')
    const { password, ...policy } = backupScheduleInputSchema.parse(input)
    const previous = this.#records.find(item => item.connectionId === connectionId)
    if (policy.credentials && !password && !previous?.credentialId)
      throw new Error('BACKUP_PASSWORD_REQUIRED')
    const credentialId = policy.credentials ? (password ? randomUUID() : previous!.credentialId) : null
    if (password && credentialId)
      await this.credentials.write('backup', credentialId, password)
    const record: ScheduleRecord = {
      connectionId,
      automatic: previous?.automatic ?? randomUUID(),
      policy,
      credentialId,
      nextRunAt: immediate ? now.toISOString() : nextBackupTime(policy, now),
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      retryAt: null,
      pendingId: null,
      error: null,
      cleanupError: false,
      manual: immediate,
    }
    const records = [...this.#records.filter(item => item.connectionId !== connectionId), record]
    await writeStorageJson(this.#path, { version: 1, records })
    this.#records = records
    this.#statuses.delete(connectionId)
    if (immediate)
      this.#statuses.set(connectionId, 'waiting')
    if (previous?.credentialId && previous.credentialId !== credentialId)
      await this.credentials.delete('backup', previous.credentialId).catch(() => {})
    this.publish()
  }

  async activate(connectionId: string, { immediate = true, now = new Date() }: { immediate?: boolean, now?: Date } = {}) {
    if (this.unavailable)
      throw new Error('BACKUP_SCHEDULE_UNAVAILABLE')
    let record = this.#records.find(item => item.connectionId === connectionId)
    if (!record) {
      await this.save(connectionId, defaultPolicy(now), now)
      record = this.#records.find(item => item.connectionId === connectionId)!
    }
    if (record.policy.frequency === 'manual')
      record.policy.frequency = 'daily'
    if (immediate)
      record.nextRunAt = now.toISOString()
    else if (!record.nextRunAt || Date.parse(record.nextRunAt) <= now.getTime())
      record.nextRunAt = nextBackupTime(record.policy, now)
    record.retryAt = null
    record.error = null
    this.#statuses.set(connectionId, immediate ? 'waiting' : 'idle')
    await this.#persist()
  }

  async setFrequency(connectionId: string, frequency: 'hourly' | 'daily' | 'weekly') {
    if (this.unavailable)
      throw new Error('BACKUP_SCHEDULE_UNAVAILABLE')
    const record = this.#records.find(item => item.connectionId === connectionId)
    if (!record)
      throw new Error('SYNC_CONNECTION_MISSING')
    record.policy.frequency = frequency
    if (!record.pendingId && this.#statuses.get(connectionId) !== 'waiting')
      record.nextRunAt = nextBackupTime(record.policy, new Date())
    await this.#persist()
  }

  async requestNow(connectionId: string, options: BackupOptions, frequency?: 'hourly' | 'daily' | 'weekly') {
    const now = new Date()
    const previous = this.#records.find(item => item.connectionId === connectionId)
    await this.save(connectionId, { ...(previous?.policy ?? defaultPolicy(now)), ...options, ...(frequency ? { frequency } : {}) }, now, true)
  }

  kick() {
    setTimeout(() => {
      void this.tick().catch(() => {
        this.unavailable = true
        this.publish()
      })
    }, 0).unref()
  }

  async remove(connectionId: string) {
    if (this.unavailable)
      return
    const previous = this.#records.find(item => item.connectionId === connectionId)
    const records = this.#records.filter(item => item.connectionId !== connectionId)
    await writeStorageJson(this.#path, { version: 1, records })
    this.#records = records
    this.#statuses.delete(connectionId)
    if (previous?.credentialId)
      await this.credentials.delete('backup', previous.credentialId).catch(() => {})
    this.publish()
  }

  async tick(now = new Date()) {
    if (this.#disposed || this.unavailable || this.#running || this.backups.busy || !this.hub.state().enabled || this.hub.state().activity?.state === 'running')
      return
    const record = this.#records.find(item => item.policy.frequency !== 'manual' && item.nextRunAt && Date.parse(item.nextRunAt) <= now.getTime() && (!item.retryAt || Date.parse(item.retryAt) <= now.getTime()) && this.hub.state().activeConnectionId === item.connectionId)
    if (!record)
      return
    this.#running = true
    try {
      await this.backups.run(async () => {
        if (this.#disposed || !this.hub.state().enabled || this.hub.state().activeConnectionId !== record.connectionId)
          return
        this.#statuses.set(record.connectionId, 'running')
        this.publish()
        try {
          if (!record.pendingId) {
            const password = record.credentialId ? await this.credentials.read('backup', record.credentialId) : undefined
            if (record.policy.credentials && typeof password !== 'string')
              throw new Error('BACKUP_PASSWORD_REQUIRED')
            const snapshot = await this.backups.create({ scopes: record.policy.scopes, credentials: record.policy.credentials, ...(typeof password === 'string' ? { password } : {}) }, record.manual ? undefined : record.automatic)
            record.pendingId = snapshot.id
            await this.#persist()
          }
          await this.hub.run('upload', record.connectionId, record.pendingId)
          record.lastSuccessAt = now.toISOString()
          record.nextRunAt = nextBackupTime(record.policy, now)
          record.error = null
          record.retryAt = null
          record.pendingId = null
          record.manual = false
          await this.#persist()
          try {
            await this.backups.prune()
            record.cleanupError = false
          }
          catch { record.cleanupError = true }
          this.#statuses.set(record.connectionId, 'idle')
          await this.#persist()
        }
        catch (error) {
          const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BACKUP_FAILED'
          const waiting = ['SNAPSHOT_RUNTIME_BUSY', 'STORAGE_OPERATION_PENDING', 'SYNC_BUSY'].includes(code)
          this.#statuses.set(record.connectionId, waiting ? 'waiting' : 'failed')
          record.error = waiting ? null : code
          record.retryAt = new Date(now.getTime() + (waiting ? 60_000 : 5 * 60_000)).toISOString()
          await this.#persist()
        }
      })
    }
    finally { this.#running = false }
  }

  dispose() {
    this.#disposed = true
    clearInterval(this.#timer)
  }
}
