import type { BrowserWindow } from 'electron'
import type { BackupOptions } from '../../../shared/storage/backupScope'
import type { StorageSummary } from '../../../shared/storage/storageApi'
import type { DesktopRuntimeHost } from '../app/DesktopRuntimeHost'
import type { DesktopEnvironment } from '../app/typing'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptBackupCredentials, encryptBackupCredentials } from '../../../platform/storage/backupEncryption'
import { copySnapshot } from '../../../platform/storage/copySnapshot'
import { consumeSnapshotFile } from '../../../platform/storage/snapshotFile'
import { readSnapshotManifest, SnapshotRepository } from '../../../platform/storage/SnapshotRepository'
import { assertStorageIdentity } from '../../../platform/storage/StorageLocationStore'
import { restoreCredentialStage } from '../../../platform/storage/storageOperationFiles'
import { verifySnapshotFiles } from '../../../platform/storage/verifySnapshotFiles'
import { runsRpc } from '../../../shared/runs/runApi'
import { snapshotSummary } from '../../../shared/storage/snapshot'
import { STORAGE_CHANGED } from '../../../shared/storage/storageApi'
import { exportBackupCredentials, stageBackupCredentials } from './backupCredentials'
import { runSnapshotWorker } from './runStorageWorker'

export class StorageBackupService {
  readonly snapshots: SnapshotRepository
  readonly controller = new AbortController()
  protectedSnapshots = () => new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()
  #pending = 0
  #cleanupError = false
  readonly environment: DesktopEnvironment
  readonly getWindow: () => BrowserWindow | null
  readonly runtime: DesktopRuntimeHost
  constructor(environment: DesktopEnvironment, getWindow: () => BrowserWindow | null, runtime: DesktopRuntimeHost) {
    this.environment = environment
    this.getWindow = getWindow
    this.runtime = runtime
    this.snapshots = new SnapshotRepository(join(environment.paths.lexoraHome, 'exports', 'snapshots'))
  }

  get busy() { return this.#pending > 0 }

  async catalog() {
    return { ...await this.snapshots.list(), cleanupError: this.#cleanupError }
  }

  async summary(): Promise<StorageSummary> {
    const { store } = this.environment.storage
    const state = await store.read()
    await assertStorageIdentity(state)
    return { root: state.activeRoot, defaultRoot: store.defaultRoot, identity: state.identity!, pending: state.pending, history: state.history }
  }

  async relocate(target: string) {
    await this.environment.storage.store.request('relocate', target)
    return this.summary()
  }

  async cancel() {
    await this.environment.storage.store.cancel()
    return this.summary()
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.#pending++
    const result = this.#queue.then(() => {
      this.controller.signal.throwIfAborted()
      return operation()
    })
    this.#queue = result.catch(() => {}).finally(() => {
      this.#pending--
    })
    return result
  }

  async create(options: BackupOptions, automatic?: string) {
    if ((await this.environment.storage.store.read()).pending)
      throw new Error('STORAGE_OPERATION_PENDING')
    if (runsRpc.isBusy.response.parse(await this.runtime.service.request(runsRpc.isBusy.method, {}, { timeoutMs: 5000 })))
      throw new Error('SNAPSHOT_RUNTIME_BUSY')
    const encrypted = options.credentials ? await encryptBackupCredentials(await exportBackupCredentials(this.environment.paths.buddyHome, options.scopes), options.password!) : undefined
    try {
      const manifest = await this.runtime.withStoppedStorage(() => runSnapshotWorker(this.environment.paths.lexoraHome, this.environment.storage.state.identity!.dataId, (progress) => {
        this.getWindow()?.webContents.send(STORAGE_CHANGED, progress)
      }, this.controller.signal, this.environment.storage.privateDirectoriesExecutable, { scopes: options.scopes, credentials: options.credentials, ...(automatic ? { automatic } : {}) }, encrypted))
      await this.prune(manifest.id).catch(() => {})
      return snapshotSummary(manifest)
    }
    finally {
      this.getWindow()?.webContents.send(STORAGE_CHANGED, null)
    }
  }

  async remove(id: string) {
    if (this.protectedSnapshots().has(id) || (await this.environment.storage.store.read()).pending?.snapshotId === id)
      throw new Error('SNAPSHOT_IN_USE')
    await this.snapshots.remove(id)
  }

  async restore(id: string, options: BackupOptions) {
    const { store } = this.environment.storage
    const manifest = await this.snapshots.read(id)
    if (options.scopes.some(scope => !manifest.scopes.includes(scope)) || (options.credentials && !manifest.credentials))
      throw new Error('SNAPSHOT_SCOPE_MISSING')
    const operationId = randomUUID()
    const stage = restoreCredentialStage(store.path, operationId)
    try {
      if (options.credentials) {
        await verifySnapshotFiles(this.snapshots.directory(id), manifest, this.controller.signal)
        const entry = manifest.files.find(entry => entry.kind === 'file' && entry.path === 'credentials.enc')
        if (entry?.kind !== 'file' || entry.size > 24 * 1024 * 1024)
          throw new Error('SNAPSHOT_INVALID_CREDENTIALS')
        const bytes: Uint8Array[] = []
        await consumeSnapshotFile(this.snapshots.directory(id), entry, this.controller.signal, (chunk) => {
          bytes.push(chunk)
        })
        const value = await decryptBackupCredentials(Buffer.concat(bytes), options.password!)
        await stageBackupCredentials(stage, value, options.scopes, this.environment.events.publish)
      }
      await store.request('restore', (await store.read()).activeRoot, [], id, options.scopes, options.credentials, operationId)
    }
    catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
    return this.summary()
  }

  async import(source: string) {
    const manifest = await readSnapshotManifest(source)
    await this.#copy(source, this.snapshots.directory(manifest.id))
    await this.prune(manifest.id).catch(() => {})
    return snapshotSummary(manifest)
  }

  async export(id: string, directory: string) {
    const manifest = await this.snapshots.read(id)
    const target = join(directory, `Lexora-backup-${manifest.createdAt.replace(/[:.]/g, '-')}-${manifest.id.slice(0, 8)}`)
    await this.#copy(this.snapshots.directory(id), target)
    return target
  }

  async #copy(source: string, target: string) {
    try {
      await copySnapshot(source, target, {
        signal: this.controller.signal,
        report: progress => this.getWindow()?.webContents.send(STORAGE_CHANGED, progress),
        privateDirectoriesExecutable: this.environment.storage.privateDirectoriesExecutable,
      })
    }
    finally { this.getWindow()?.webContents.send(STORAGE_CHANGED, null) }
  }

  async prune(preserveId?: string) {
    try {
      const keep = (await this.runtime.configStore.read()).desktop.localBackupLimit
      const catalog = await this.snapshots.list()
      const retainedIds = new Set(catalog.snapshots.slice(0, keep).map(item => item.id))
      if (preserveId && !retainedIds.has(preserveId)) {
        const oldest = [...retainedIds].at(-1)
        if (oldest)
          retainedIds.delete(oldest)
        retainedIds.add(preserveId)
      }
      const protectedIds = this.protectedSnapshots()
      const pendingId = (await this.environment.storage.store.read()).pending?.snapshotId
      if (pendingId)
        protectedIds.add(pendingId)
      for (const item of catalog.snapshots) {
        this.controller.signal.throwIfAborted()
        if (!retainedIds.has(item.id) && !protectedIds.has(item.id))
          await this.snapshots.remove(item.id)
      }
      this.#cleanupError = false
    }
    catch (error) {
      this.#cleanupError = true
      this.environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'storage.backup.cleanup.failed', error })
      throw error
    }
    finally {
      this.getWindow()?.webContents.send(STORAGE_CHANGED, null)
    }
  }

  dispose() {
    this.controller.abort()
  }
}
