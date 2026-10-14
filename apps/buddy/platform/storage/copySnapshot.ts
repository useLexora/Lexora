import type { SnapshotManifest } from '../../shared/storage/snapshot'
import type { StorageReporter } from './storageTree'
import { randomUUID } from 'node:crypto'
import { lstat, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { readSnapshotManifest, writeSnapshotManifest } from './SnapshotRepository'
import { canonicalStoragePath, containsStoragePath, isMissing, storageError, syncStorageDirectory } from './storageFiles'
import { copyStorageTree, syncStorageDirectories } from './storageTree'
import { verifySnapshotFiles } from './verifySnapshotFiles'

export async function copySnapshot(source: string, target: string, options: { signal: AbortSignal, report: StorageReporter, privateDirectoriesExecutable?: string }): Promise<SnapshotManifest> {
  const manifest = await readSnapshotManifest(source)
  await verifySnapshotFiles(source, manifest, options.signal)
  const [from, to] = await Promise.all([canonicalStoragePath(source), canonicalStoragePath(target)])
  const existing = await lstat(to).catch((error) => {
    if (!isMissing(error))
      throw error
    return null
  })
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || JSON.stringify(await readSnapshotManifest(to)) !== JSON.stringify(manifest))
      throw storageError('SNAPSHOT_TARGET_CONFLICT')
    await verifySnapshotFiles(to, manifest, options.signal)
    return manifest
  }
  if (containsStoragePath(from, to) || containsStoragePath(to, from))
    throw storageError('STORAGE_PATH_OVERLAP')
  const stage = join(dirname(to), `.snapshot-${randomUUID()}`)
  await ensurePrivateDirectories([stage], options.privateDirectoriesExecutable)
  try {
    await copyStorageTree(join(from, 'files'), join(stage, 'files'), options)
    await verifySnapshotFiles(stage, manifest, options.signal)
    await writeSnapshotManifest(stage, manifest)
    await syncStorageDirectories(stage)
    options.signal.throwIfAborted()
    await rename(stage, to)
    await syncStorageDirectory(dirname(to))
    return manifest
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
}
