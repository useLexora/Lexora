import type { SyncTransport } from '../../../platform/sync/SyncAdapter'
import type { SyncActivity, SyncConnectionInput, SyncState } from '../../../shared/sync/syncApi'
import type { CredentialVault } from '../secrets/CredentialVault'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readStorageJson, writeStorageJson } from '../../../platform/storage/storageFiles'
import { createSyncAdapter } from '../../../platform/sync/createSyncAdapter'
import { probeSyncConnection } from '../../../platform/sync/probeSyncConnection'
import { SnapshotTransfer } from '../../../platform/sync/SnapshotTransfer'
import { syncConnectionStoreSchema } from '../../../platform/sync/syncConnectionStore'
import { syncConnectionSchema } from '../../../shared/sync/syncApi'

export class SyncHub {
  #state: SyncState = { enabled: false, selectedAdapter: 'webdav', activeConnectionId: null, connections: [], activity: null, schedules: [], scheduleError: false }
  #controller: AbortController | null = null
  #mutation: Promise<unknown> = Promise.resolve()
  #closed = false
  #credentialIds = new Map<string, string>()
  readonly #path: string
  readonly #snapshots: string
  readonly #transport: SyncTransport
  readonly credentials: CredentialVault
  readonly publish: (state: SyncState) => void
  readonly privateDirectoriesExecutable?: string
  constructor(root: string, credentials: CredentialVault, transport: SyncTransport, publish: (state: SyncState) => void, privateDirectoriesExecutable?: string) {
    this.privateDirectoriesExecutable = privateDirectoriesExecutable
    this.credentials = credentials
    this.publish = publish
    this.#path = join(root, 'device', 'sync.json')
    this.#snapshots = join(root, 'exports', 'snapshots')
    this.#transport = transport
  }

  async initialize(): Promise<void> {
    const raw = await readStorageJson(this.#path)
    const saved = raw ? syncConnectionStoreSchema.parse(raw) : null
    const records = saved?.connections ?? []
    this.#state.enabled = saved?.enabled ?? records.length > 0
    this.#state.selectedAdapter = saved?.selectedAdapter ?? records[0]?.adapter ?? 'webdav'
    this.#state.activeConnectionId = records.find(item => item.id === saved?.activeConnectionId && item.adapter === this.#state.selectedAdapter)?.id ?? records.find(item => item.adapter === this.#state.selectedAdapter)?.id ?? null
    this.#state.connections = records.map(({ credentialId, ...connection }) => {
      this.#credentialIds.set(connection.id, credentialId)
      return connection
    })
  }

  async testConnection(input: SyncConnectionInput): Promise<void> {
    const credential = input.password ?? (input.id ? await this.credential(input.id) : '')
    const { password: _password, ...rest } = input
    const connection = syncConnectionSchema.parse({ ...rest, id: input.id ?? randomUUID() })
    const signal = AbortSignal.timeout(30_000)
    try {
      await probeSyncConnection(createSyncAdapter(connection, credential, this.#transport), signal)
    }
    catch (error) {
      if (signal.aborted)
        throw new Error('SYNC_TIMEOUT')
      if (error instanceof Error && /^SYNC_[A-Z_]+$/.test(error.message))
        throw error
      throw new Error('SYNC_NETWORK_ERROR')
    }
  }

  async credential(id: string): Promise<string> {
    await this.#mutation
    const credentialId = this.#credentialIds.get(id)
    if (!credentialId)
      throw new Error('SYNC_CONNECTION_MISSING')
    const value = await this.credentials.read('sync', credentialId)
    if (value !== null && typeof value !== 'string')
      throw new Error('SYNC_CREDENTIAL_INVALID')
    return value ?? ''
  }

  state(): SyncState {
    return structuredClone(this.#state)
  }

  #emit() {
    this.publish(this.state())
  }

  async selectAdapter(adapter: SyncState['selectedAdapter']): Promise<SyncState> {
    return this.#serialize(async () => {
      if (this.#controller)
        throw new Error('SYNC_BUSY')
      const activeConnectionId = this.#state.connections.find(item => item.adapter === adapter)?.id ?? null
      await writeStorageJson(this.#path, {
        version: 1,
        enabled: this.#state.enabled,
        selectedAdapter: adapter,
        activeConnectionId,
        connections: this.#state.connections.map(item => ({ ...item, credentialId: this.#credentialIds.get(item.id)! })),
      })
      this.#state.selectedAdapter = adapter
      this.#state.activeConnectionId = activeConnectionId
      this.#state.activity = null
      this.#emit()
      return this.state()
    })
  }

  async setEnabled(enabled: boolean): Promise<SyncState> {
    return this.#serialize(async () => {
      if (this.#controller)
        throw new Error('SYNC_BUSY')
      await writeStorageJson(this.#path, {
        version: 1,
        enabled,
        selectedAdapter: this.#state.selectedAdapter,
        activeConnectionId: this.#state.activeConnectionId,
        connections: this.#state.connections.map(item => ({ ...item, credentialId: this.#credentialIds.get(item.id)! })),
      })
      this.#state.enabled = enabled
      this.#state.activity = null
      this.#emit()
      return this.state()
    })
  }

  async save(input: SyncConnectionInput): Promise<SyncState> {
    return this.#serialize(async () => {
      if (this.#controller)
        throw new Error('SYNC_BUSY')
      const id = input.id ?? randomUUID()
      if (input.id && !this.#state.connections.some(connection => connection.id === id))
        throw new Error('SYNC_CONNECTION_MISSING')
      const { password, ...rest } = input
      const connection = syncConnectionSchema.parse({ ...rest, id })
      const previousCredentialId = this.#credentialIds.get(id)
      const previous = this.#state.connections.find(item => item.id === id)
      if (connection.adapter === 's3' && !password && (!previousCredentialId || previous?.adapter !== 's3'))
        throw new Error('SYNC_CREDENTIAL_REQUIRED')
      if (previous && previous.adapter !== connection.adapter)
        throw new Error('SYNC_ADAPTER_CHANGED')
      const credentialId = password !== undefined || !previousCredentialId ? randomUUID() : previousCredentialId
      const connections = [...this.#state.connections.filter(connection => connection.id !== id), connection]
      const records = connections.map(item => ({ ...item, credentialId: item.id === id ? credentialId : this.#credentialIds.get(item.id)! }))
      const activeConnectionId = connection.adapter === this.#state.selectedAdapter ? id : this.#state.activeConnectionId
      const saved = syncConnectionStoreSchema.parse({ version: 1, enabled: this.#state.enabled, selectedAdapter: this.#state.selectedAdapter, activeConnectionId, connections: records })
      if (credentialId !== previousCredentialId)
        await this.credentials.write('sync', credentialId, password ?? '')
      await writeStorageJson(this.#path, saved)
      this.#credentialIds.set(id, credentialId)
      this.#state.connections = connections
      this.#state.activeConnectionId = activeConnectionId
      if (previousCredentialId && credentialId !== previousCredentialId)
        await this.credentials.delete('sync', previousCredentialId).catch(() => {})
      this.#emit()
      return this.state()
    })
  }

  async remove(id: string): Promise<SyncState> {
    return this.#serialize(async () => {
      if (this.#controller)
        throw new Error('SYNC_BUSY')
      const connections = this.#state.connections.filter(connection => connection.id !== id)
      const activeConnectionId = this.#state.activeConnectionId === id ? null : this.#state.activeConnectionId
      await writeStorageJson(this.#path, { version: 1, enabled: this.#state.enabled, selectedAdapter: this.#state.selectedAdapter, activeConnectionId, connections: connections.map(item => ({ ...item, credentialId: this.#credentialIds.get(item.id)! })) })
      this.#state.connections = connections
      this.#state.activeConnectionId = activeConnectionId
      const credentialId = this.#credentialIds.get(id)
      this.#credentialIds.delete(id)
      if (credentialId)
        await this.credentials.delete('sync', credentialId).catch(() => {})
      this.#emit()
      return this.state()
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#mutation.then(() => {
      if (this.#closed)
        throw new Error('SYNC_STOPPED')
      return operation()
    })
    this.#mutation = pending.catch(() => { })
    return pending
  }

  async run(action: SyncActivity['action'], id: string, snapshotId?: string, retention?: { automatic: string, keep: number }) {
    await this.#mutation
    if (this.#controller || this.#closed)
      throw new Error('SYNC_BUSY')
    if (!this.#state.enabled)
      throw new Error('SYNC_DISABLED')
    const connection = this.#state.connections.find(connection => connection.id === id)
    if (!connection)
      throw new Error('SYNC_CONNECTION_MISSING')
    this.#controller = new AbortController()
    const signal = this.#controller.signal
    this.#state.activity = { connectionId: id, action, state: 'running', completedBytes: 0, totalBytes: null, error: null }
    this.#emit()
    try {
      const credential = await this.credentials.read('sync', this.#credentialIds.get(id)!)
      if (credential !== null && typeof credential !== 'string')
        throw new Error('SYNC_CREDENTIAL_INVALID')
      const adapter = createSyncAdapter(connection, credential ?? '', this.#transport)
      const transfer = new SnapshotTransfer(adapter, this.#snapshots, (completedBytes, totalBytes) => {
        this.#state.activity = { ...this.#state.activity!, completedBytes, totalBytes }
        this.#emit()
      }, this.privateDirectoriesExecutable)
      const result = action === 'prune' ? await transfer.pruneAutomatic(retention!.automatic, retention!.keep, signal) : action === 'test' ? await adapter.test(signal) : action === 'list' ? await transfer.list(signal) : action === 'upload' ? await transfer.upload(snapshotId!, signal) : await transfer.download(snapshotId!, signal)
      this.#state.activity = { ...this.#state.activity!, state: 'completed' }
      return result
    }
    catch (error) {
      const code = signal.aborted ? 'SYNC_CANCELLED' : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'SYNC_FAILED'
      this.#state.activity = { ...this.#state.activity!, state: signal.aborted ? 'cancelled' : 'failed', error: code }
      throw new Error(code)
    }
    finally {
      this.#controller = null
      this.#emit()
    }
  }

  cancel(): void {
    this.#controller?.abort()
  }

  dispose(): void {
    this.#closed = true
    this.cancel()
  }
}
