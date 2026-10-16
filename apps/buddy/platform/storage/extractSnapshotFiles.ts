import type { SnapshotManifest } from '../../shared/storage/snapshot'
import type { StorageReporter } from './storageTree'
import { mkdir, open, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { consumeSnapshotFile } from './snapshotFile'
import { storageError } from './storageFiles'
import { hashStorageFile, syncStorageDirectories } from './storageTree'

export async function extractSnapshotFiles(directory: string, target: string, manifest: SnapshotManifest, options: {
  signal: AbortSignal
  report: StorageReporter
  privateDirectoriesExecutable?: string
  exclude?: (path: string) => boolean
}): Promise<void> {
  const entries = manifest.files.filter(entry => !options.exclude?.(entry.path))
  const totalBytes = entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0)
  await ensurePrivateDirectories([target], options.privateDirectoriesExecutable)
  const disk = await statfs(target)
  if (disk.bavail * disk.bsize < totalBytes * 1.1 + 16 * 1024 * 1024)
    throw storageError('STORAGE_NO_SPACE')
  let completedBytes = 0
  let files = 0
  let lastReport = 0
  for (const entry of entries) {
    options.signal.throwIfAborted()
    const path = join(target, entry.path)
    if (entry.kind === 'directory') {
      await mkdir(path, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'wx', entry.executable ? 0o700 : 0o600)
    try {
      await consumeSnapshotFile(directory, entry, options.signal, async (bytes) => {
        await file.writeFile(bytes)
        completedBytes += bytes.length
        if (Date.now() - lastReport >= 100) {
          options.report({ phase: 'copying', completedBytes, totalBytes, files, error: null })
          lastReport = Date.now()
        }
      })
      await file.sync()
    }
    finally { await file.close() }
    if (await hashStorageFile(path, options.signal) !== entry.hash)
      throw storageError('STORAGE_COPY_INVALID')
    files++
  }
  await syncStorageDirectories(target)
}
