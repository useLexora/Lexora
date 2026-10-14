import type { SnapshotManifest } from '../../shared/storage/snapshot'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { storageError } from './storageFiles'
import { hashStorageFile, walkStorage } from './storageTree'

export async function verifySnapshotFiles(directory: string, manifest: SnapshotManifest, signal: AbortSignal): Promise<void> {
  const root = join(directory, 'files')
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw storageError('SNAPSHOT_INVALID_LINK')
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]))
  for await (const entry of walkStorage(root)) {
    signal.throwIfAborted()
    const recorded = expected.get(entry.path)
    if (entry.link !== null || !recorded || entry.directory !== (recorded.kind === 'directory'))
      throw storageError('SNAPSHOT_UNEXPECTED_FILE')
    if (recorded.kind === 'file' && (entry.size !== recorded.size || await hashStorageFile(join(root, entry.path), signal) !== recorded.hash))
      throw storageError('SNAPSHOT_CHECKSUM_FAILED')
    expected.delete(entry.path)
  }
  if (expected.size)
    throw storageError('SNAPSHOT_FILE_MISSING')
}
