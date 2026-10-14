import type { BackupOptions } from '../../../shared/storage/backupScope'
import type { SnapshotManifest } from '../../../shared/storage/snapshot'
import type { StorageProgress } from '../../../shared/storage/storageApi'
import { Worker } from 'node:worker_threads'

export function runSnapshotWorker(root: string, dataId: string, report: (progress: StorageProgress) => void, signal: AbortSignal, privateDirectoriesExecutable?: string, options?: BackupOptions & { automatic?: string }, encryptedCredentials?: Uint8Array): Promise<SnapshotManifest> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./storage-worker.js', import.meta.url), { workerData: { kind: 'snapshot', root, dataId, privateDirectoriesExecutable, options, encryptedCredentials } })
    const cancel = () => worker.postMessage('cancel')
    signal.addEventListener('abort', cancel, { once: true })
    let settled = false
    worker.on('message', (message: {
      progress?: StorageProgress
      snapshot?: SnapshotManifest
      error?: string
    }) => {
      if (message.progress)
        report(message.progress)
      if (message.snapshot) {
        settled = true
        resolve(message.snapshot)
      }
      if (message.error) {
        settled = true
        reject(new Error(message.error))
      }
    })
    worker.on('error', reject)
    worker.on('exit', () => {
      signal.removeEventListener('abort', cancel)
      if (!settled)
        reject(new Error('STORAGE_WORKER_INTERRUPTED'))
    })
  })
}
