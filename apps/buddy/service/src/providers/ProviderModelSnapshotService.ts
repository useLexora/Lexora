import type { ModelMetadataCatalog } from './ModelsDevCatalog'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

export class ProviderModelSnapshotService implements ModelMetadataCatalog {
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
        this.#updatedAt = snapshot.updatedAt
        this.#catalog = catalog
        this.#source = 'remote'
        this.#checkedAt = snapshot.updatedAt
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
    this.#refreshRequest ??= this.#runRefresh().finally(() => {
      this.#refreshRequest = null
    })
    return this.#refreshRequest
  }

  async #runRefresh(): Promise<ProviderModelSnapshotStatus> {
    this.#lastAttemptAt = this.#now().toISOString()
    try {
      const response = await this.#fetch('https://models.dev/api.json', {
        signal: AbortSignal.timeout(15_000),
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
          await rename(temporaryPath, this.#snapshotPath)
        }
        finally {
          await rm(temporaryPath, { force: true })
        }
      }
      this.#updatedAt = snapshot.updatedAt
      this.#catalog = catalog
      this.#source = 'remote'
      this.#checkedAt = snapshot.updatedAt
      this.#errorCount = 0
    }
    catch {
      this.#errorCount = 1
    }
    return this.getStatus()
  }
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('Invalid model snapshot')
  }
  return { version: 1, updatedAt: value.updatedAt, data: value.data }
}
