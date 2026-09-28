import type { ModelMetadataCatalog } from './ModelsDevCatalog'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import bundledSnapshotPath from './data/models-dev.json?asset'
import { isRecord, ModelsDevCatalog } from './ModelsDevCatalog'

export interface ProviderModelSnapshotStatus {
  checkedAt: string | null
  errorCount: number
  generatedAt: string | null
  lastAttemptAt: string | null
  modelCount: number
  providerCount: number
  source: 'builtin' | 'remote'
  updatedAt: string | null
}

interface Snapshot {
  version: 1
  updatedAt: string
  data: unknown
}

interface ProviderModelSnapshotServiceOptions {
  snapshotPath?: string
  builtin?: unknown
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024

export interface ModelMetadataChange {
  readonly revision: number
  readonly catalogRevision: number
  readonly operationId: string
  readonly kind: 'refresh-started' | 'disk-committed' | 'accepted' | 'refresh-completed' | 'refresh-failed' | 'refresh-cancelled' | 'cleanup-failed'
  readonly source: 'builtin' | 'remote'
  readonly modelCount: number
  readonly providerCount: number
}

export class ProviderModelSnapshotService implements ModelMetadataCatalog {
  readonly #changes = new Emitter<ModelMetadataChange>(() => console.error('MODEL_METADATA_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #catalogRevision = 0
  #fingerprint: string
  #stopped = false
  readonly #controller = new AbortController()
  readonly #snapshotPath: string | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => Date
  readonly #generatedAt: string
  #updatedAt: string
  #catalog: ModelsDevCatalog
  #source: 'builtin' | 'remote' = 'builtin'
  #errorCount = 0
  #checkedAt: string | null = null
  #lastAttemptAt: string | null = null
  #refreshRequest: Promise<ProviderModelSnapshotStatus> | null = null

  constructor(options: ProviderModelSnapshotServiceOptions = {}) {
    this.#snapshotPath = options.snapshotPath
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? (() => new Date())
    const snapshot = parseSnapshot(options.builtin ?? JSON.parse(readFileSync(bundledSnapshotPath, 'utf8')))
    this.#generatedAt = snapshot.updatedAt
    this.#updatedAt = snapshot.updatedAt
    this.#catalog = new ModelsDevCatalog(snapshot.data)
    this.#fingerprint = catalogFingerprint(this.#catalog)
  }

  async initialize(): Promise<void> {
    if (!this.#snapshotPath)
      return
    try {
      if ((await stat(this.#snapshotPath)).size > MAX_SNAPSHOT_BYTES)
        return
      const snapshot = parseSnapshot(JSON.parse(await readFile(this.#snapshotPath, 'utf8')))
      const catalog = new ModelsDevCatalog(snapshot.data)
      if (Date.parse(snapshot.updatedAt) >= Date.parse(this.#generatedAt)) {
        if (!this.#stopped)
          this.#accept(catalog, snapshot.updatedAt, randomUUID())
      }
    }
    catch {

    }
  }

  getModels(providerId?: string) {
    return this.#catalog.getModels(providerId)
  }

  getProviders() {
    return this.#catalog.getProviders()
  }

  async getStatus(): Promise<ProviderModelSnapshotStatus> {
    return {
      checkedAt: this.#checkedAt,
      errorCount: this.#errorCount,
      generatedAt: this.#generatedAt,
      lastAttemptAt: this.#lastAttemptAt,
      modelCount: this.getModels().length,
      providerCount: this.getProviders().length,
      source: this.#source,
      updatedAt: this.#updatedAt,
    }
  }

  refresh(): Promise<ProviderModelSnapshotStatus> {
    if (this.#stopped)
      return Promise.reject(new Error('MODEL_METADATA_STOPPED'))
    if (this.#refreshRequest)
      return this.#refreshRequest
    const pending = Promise.withResolvers<ProviderModelSnapshotStatus>()
    this.#refreshRequest = pending.promise
    void this.#runRefresh().then((result) => {
      this.#refreshRequest = null
      pending.resolve(result)
    }, (error: unknown) => {
      this.#refreshRequest = null
      pending.reject(error)
    })
    return pending.promise
  }

  async #runRefresh(): Promise<ProviderModelSnapshotStatus> {
    this.#lastAttemptAt = this.#now().toISOString()
    const operationId = randomUUID()
    this.#publish('refresh-started', operationId)
    try {
      const response = await this.#fetch('https://models.dev/api.json', {
        signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      })
      if (!response.ok || !response.body)
        throw new Error('Model snapshot download failed')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const result = await reader.read()
          if (result.done)
            break
          size += result.value.byteLength
          if (size > MAX_SNAPSHOT_BYTES)
            throw new Error('Model snapshot exceeds size limit')
          chunks.push(result.value)
        }
      }
      finally {
        await reader.cancel()
      }
      const data: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
      const catalog = new ModelsDevCatalog(data)
      const snapshot: Snapshot = { version: 1, updatedAt: this.#now().toISOString(), data }
      if (this.#snapshotPath) {
        await mkdir(dirname(this.#snapshotPath), { recursive: true, mode: 0o700 })
        const temporaryPath = `${this.#snapshotPath}.${randomUUID()}.tmp`
        try {
          await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' })
          this.#controller.signal.throwIfAborted()
          await rename(temporaryPath, this.#snapshotPath)
          this.#publish('disk-committed', operationId, catalog)
          this.#errorCount = 0
          this.#accept(catalog, snapshot.updatedAt, operationId)
        }
        finally {
          try {
            await rm(temporaryPath, { force: true })
          }
          catch { this.#publish('cleanup-failed', operationId) }
        }
      }
      else {
        this.#controller.signal.throwIfAborted()
        this.#errorCount = 0
        this.#accept(catalog, snapshot.updatedAt, operationId)
      }
      this.#publish('refresh-completed', operationId)
    }
    catch {
      this.#errorCount = 1
      this.#publish(this.#stopped ? 'refresh-cancelled' : 'refresh-failed', operationId)
    }
    return this.getStatus()
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    this.#controller.abort()
    await this.#refreshRequest
    this.#changes.dispose()
  }

  #accept(catalog: ModelsDevCatalog, updatedAt: string, operationId: string): void {
    const fingerprint = catalogFingerprint(catalog)
    const changed = fingerprint !== this.#fingerprint
    const sourceChanged = this.#source !== 'remote'
    this.#fingerprint = fingerprint
    this.#catalog = catalog
    this.#source = 'remote'
    this.#updatedAt = updatedAt
    this.#checkedAt = updatedAt
    if (changed)
      this.#catalogRevision++
    if (changed || sourceChanged)
      this.#publish('accepted', operationId)
  }

  #publish(kind: ModelMetadataChange['kind'], operationId: string, committed?: ModelsDevCatalog): void {
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, catalogRevision: this.#catalogRevision, operationId, kind, source: committed ? 'remote' : this.#source, modelCount: (committed ?? this).getModels().length, providerCount: (committed ?? this).getProviders().length }))
  }
}

function catalogFingerprint(catalog: ModelsDevCatalog): string {
  return createHash('sha256').update(JSON.stringify({ providers: [...catalog.getProviders()].sort((a, b) => a.id.localeCompare(b.id)), models: [...catalog.getModels()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)) })).digest('hex')
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('Invalid model snapshot')
  }
  return { version: 1, updatedAt: value.updatedAt, data: value.data }
}
