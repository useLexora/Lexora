import type { DesktopStorage } from './storageBootstrap'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, storageError } from '../../../platform/storage/storageFiles'
import { BUDDY_SCHEMA_VERSION } from '../../../service/src/storage/schema'
import { snapshotDatabaseVersion } from '../../../service/src/storage/snapshotDatabase'

export async function requestPersistenceUpgrade(storage: DesktopStorage): Promise<void> {
  if (storage.state.pending)
    return
  const path = join(storage.state.activeRoot, 'buddy', 'buddy.sqlite3')
  const metadata = await lstat(path).catch((error) => {
    if (!isMissing(error))
      throw error
    return null
  })
  if (!metadata)
    return
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw storageError('STORAGE_DATABASE_INVALID')
  if (snapshotDatabaseVersion(path) <= BUDDY_SCHEMA_VERSION)
    await storage.store.request('upgrade', storage.state.activeRoot)
}
