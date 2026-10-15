import type { SnapshotCatalog, SnapshotManifest, SnapshotSummary } from '../../shared/storage/snapshot'
import type { SyncAdapter } from './SyncAdapter'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MANIFEST_BYTES, snapshotSummary } from '../../shared/storage/snapshot'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { collectSnapshotCatalog, encodeSnapshotManifest, parseSnapshotManifest, SnapshotRepository, writeSnapshotManifest } from '../storage/SnapshotRepository'
import { isMissing, syncStorageDirectory } from '../storage/storageFiles'
import { syncStorageDirectories } from '../storage/storageTree'
import { verifySnapshotFiles } from '../storage/verifySnapshotFiles'

const chunkKey = (manifest: SnapshotManifest, hash: string) => `objects/${manifest.automatic ? `${manifest.id}-` : ''}${hash}`
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export class SnapshotTransfer {
  readonly adapter: SyncAdapter
  readonly root: string
  readonly progress: (completed: number, total: number) => void
  readonly privateDirectoriesExecutable?: string
  constructor(adapter: SyncAdapter, root: string, progress: (completed: number, total: number) => void, privateDirectoriesExecutable?: string) {
    this.adapter = adapter
    this.privateDirectoriesExecutable = privateDirectoriesExecutable
    this.root = root
    this.progress = progress
  }

  async list(signal: AbortSignal): Promise<SnapshotCatalog> {
    const ids = await this.adapter.list(signal)
    return collectSnapshotCatalog(ids, id => this.#manifest(id, signal), signal)
  }

  async #manifest(id: string, signal: AbortSignal): Promise<SnapshotManifest> {
    const bytes = await this.adapter.read(`snapshots/${id}.json`, SNAPSHOT_MANIFEST_BYTES, signal)
    if (!bytes)
      throw new Error('SYNC_SNAPSHOT_MISSING')
    if (bytes.length > SNAPSHOT_MANIFEST_BYTES)
      throw new Error('SNAPSHOT_MANIFEST_TOO_LARGE')
    return parseSnapshotManifest(JSON.parse(new TextDecoder().decode(bytes)), id)
  }

  async upload(id: string, signal: AbortSignal): Promise<void> {
    const repository = new SnapshotRepository(this.root)
    const directory = repository.directory(id)
    const manifest = await repository.read(id)
    const manifestBytes = encodeSnapshotManifest(manifest)
    await verifySnapshotFiles(directory, manifest, signal)
    await this.adapter.prepare(signal)
    const total = snapshotSummary(manifest).bytes
    let completed = 0
    for (const entry of manifest.files) {
      if (entry.kind !== 'file')
        continue
      const file = await open(join(directory, 'files', entry.path), 'r')
      try {
        let offset = 0
        for (const chunk of entry.chunks) {
          signal.throwIfAborted()
          const bytes = new Uint8Array(chunk.size)
          let filled = 0
          while (filled < bytes.length) {
            const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, offset + filled)
            if (!bytesRead)
              throw new Error('SYNC_SNAPSHOT_CHANGED')
            filled += bytesRead
          }
          if (hash(bytes) !== chunk.hash)
            throw new Error('SYNC_SNAPSHOT_CHANGED')
          await this.adapter.write(chunkKey(manifest, chunk.hash), bytes, signal)
          offset += filled
          completed += filled
          this.progress(completed, total)
        }
      }
      finally {
        await file.close()
      }
    }
    signal.throwIfAborted()
    await this.adapter.write(`snapshots/${id}.json`, manifestBytes, signal)
  }

  async download(id: string, signal: AbortSignal): Promise<SnapshotSummary> {
    const manifest = await this.#manifest(id, signal)
    const repository = new SnapshotRepository(this.root)
    const directory = repository.directory(id)
    const existing = await repository.read(id).catch((error) => {
      if (!isMissing(error) && error?.message !== 'SNAPSHOT_MISSING')
        throw error
      return null
    })
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(manifest))
        throw new Error('SYNC_SNAPSHOT_CONFLICT')
      await verifySnapshotFiles(directory, manifest, signal)
      return snapshotSummary(manifest)
    }
    const stage = join(this.root, `.storage-${randomUUID()}`)
    await ensurePrivateDirectories([stage], this.privateDirectoriesExecutable)
    await mkdir(join(stage, 'files'), { mode: 0o700 })
    const total = snapshotSummary(manifest).bytes
    let completed = 0
    try {
      for (const entry of manifest.files) {
        signal.throwIfAborted()
        const path = join(stage, 'files', entry.path)
        if (entry.kind === 'directory') {
          await mkdir(path, { recursive: true, mode: 0o700 })
          continue
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const file = await open(path, 'wx', entry.executable ? 0o700 : 0o600)
        const digest = createHash('sha256')
        try {
          for (const chunk of entry.chunks) {
            const bytes = await this.adapter.read(chunkKey(manifest, chunk.hash), SNAPSHOT_CHUNK_BYTES, signal)
            if (!bytes || bytes.length !== chunk.size || hash(bytes) !== chunk.hash)
              throw new Error('SYNC_CHECKSUM_FAILED')
            digest.update(bytes)
            await file.writeFile(bytes)
            completed += bytes.length
            this.progress(completed, total)
          }
          await file.sync()
          if (digest.digest('hex') !== entry.hash)
            throw new Error('SYNC_CHECKSUM_FAILED')
        }
        finally {
          await file.close()
        }
      }
      await writeSnapshotManifest(stage, manifest)
      signal.throwIfAborted()
      await syncStorageDirectories(stage)
      await rename(stage, directory)
      await syncStorageDirectory(this.root)
      return snapshotSummary(manifest)
    }
    catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
  }
}
