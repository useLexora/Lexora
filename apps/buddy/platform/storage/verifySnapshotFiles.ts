import type { SnapshotManifest } from '../../shared/storage/snapshot'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotStoredBytes } from '../../shared/storage/snapshot'
import { consumeSnapshotFile } from './snapshotFile'
import { storageError } from './storageFiles'
import { walkStorage } from './storageTree'

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
    if (recorded.kind === 'file') {
      if (entry.size !== snapshotStoredBytes(recorded))
        throw storageError('SNAPSHOT_CHECKSUM_FAILED')
      await consumeSnapshotFile(directory, recorded, signal, () => {})
    }
    expected.delete(entry.path)
  }
  if (expected.size)
    throw storageError('SNAPSHOT_FILE_MISSING')
}
