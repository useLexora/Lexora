import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensurePrivateDirectoriesSync } from '../filesystem/privateDirectories'
import { isMissing, storageError } from './storageFiles'

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  }
  catch (error) {
    if (!isMissing(error))
      throw error
    return join(canonical(dirname(path)), path.slice(dirname(path).length + 1))
  }
}
export function acquireStorageRootLease(root: string, directory = join(homedir(), '.lexora-locations', 'locks'), privateDirectoriesExecutable?: string): () => void {
  ensurePrivateDirectoriesSync([directory], privateDirectoriesExecutable)
  const identity = createHash('sha256').update(canonical(resolve(root))).digest('hex')
  const database = new DatabaseSync(join(directory, `${identity}.sqlite3`))
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;')
  }
  catch {
    database.close()
    throw storageError('STORAGE_ROOT_IN_USE')
  }
  return () => database.close()
}
