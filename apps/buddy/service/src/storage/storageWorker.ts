import type { StorageMigrationInput } from './StorageMigration'
import { parentPort, workerData } from 'node:worker_threads'
import { runStorageMigration } from './StorageMigration'
import { createStorageSnapshot } from './StorageSnapshots'

const controller = new AbortController()
parentPort!.on('message', (message: unknown) => {
  if (message === 'cancel')
    controller.abort()
})
if (workerData.kind === 'snapshot') {
  void createStorageSnapshot(workerData.root, workerData.dataId, controller.signal, progress => parentPort!.postMessage({ progress }), workerData.privateDirectoriesExecutable, workerData.options, workerData.encryptedCredentials).then(snapshot => parentPort!.postMessage({ snapshot }), error => parentPort!.postMessage({ error: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'SNAPSHOT_FAILED' })).finally(() => parentPort!.close())
}
else {
  void runStorageMigration(workerData as StorageMigrationInput, controller.signal, progress => parentPort!.postMessage({ progress })).then(() => {
    parentPort!.postMessage({ done: true })
  }, () => {
    parentPort!.postMessage({ done: false })
  }).finally(() => parentPort!.close())
}
