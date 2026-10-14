import type { SnapshotCatalog, SnapshotManifest } from '../../shared/storage/snapshot'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { SNAPSHOT_MANIFEST_BYTES, snapshotManifestSchema, snapshotSummary } from '../../shared/storage/snapshot'
import { isMissing, readStorageJson, storageError, writeStorageJson } from './storageFiles'

export function parseSnapshotManifest(value: unknown, id?: string): SnapshotManifest {
  const result = snapshotManifestSchema.safeParse(value)
  if (!result.success || (id !== undefined && result.data.id !== id))
    throw storageError('SNAPSHOT_INVALID_METADATA')
  return result.data
}

export function encodeSnapshotManifest(manifest: SnapshotManifest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(parseSnapshotManifest(manifest)))
  if (bytes.length > SNAPSHOT_MANIFEST_BYTES)
    throw storageError('SNAPSHOT_MANIFEST_TOO_LARGE')
  return bytes
}

export async function collectSnapshotCatalog(ids: string[], read: (id: string) => Promise<SnapshotManifest>, signal?: AbortSignal): Promise<SnapshotCatalog> {
  const result: SnapshotCatalog = { snapshots: [], unreadableIds: [] }
  for (const id of ids) {
    signal?.throwIfAborted()
    try {
      result.snapshots.push(snapshotSummary(await read(id)))
    }
    catch {
      signal?.throwIfAborted()
      result.unreadableIds.push(id)
    }
  }
  result.snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return result
}

export class SnapshotRepository {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  directory(id: string): string {
    return join(this.root, z.uuid().parse(id))
  }

  async read(id: string): Promise<SnapshotManifest> {
    return readSnapshotManifest(this.directory(id), id)
  }

  async remove(id: string): Promise<void> {
    await rm(this.directory(id), { recursive: true, force: true })
  }

  async list(): Promise<SnapshotCatalog> {
    const entries = await readdir(this.root).catch((error) => {
      if (!isMissing(error))
        throw error
      return []
    })
    return collectSnapshotCatalog(entries.filter(id => z.uuid().safeParse(id).success), id => this.read(id))
  }
}

export async function readSnapshotManifest(directory: string, id?: string): Promise<SnapshotManifest> {
  const raw = await readStorageJson(join(directory, 'manifest.json'), SNAPSHOT_MANIFEST_BYTES)
  if (raw === null)
    throw storageError('SNAPSHOT_MISSING')
  return parseSnapshotManifest(raw, id)
}

export async function writeSnapshotManifest(directory: string, manifest: SnapshotManifest): Promise<void> {
  encodeSnapshotManifest(manifest)
  await writeStorageJson(join(directory, 'manifest.json'), manifest)
}
