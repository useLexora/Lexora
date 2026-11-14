import type { StorageCommand } from './CommandCommitter'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CommandCommitter } from './CommandCommitter'
import { BUDDY_MIGRATION_SCHEMA_VERSION } from './schema'
import { requireSqliteAuthority } from './sqliteAuthority'

export function verifyCommandReceipt(options: {
  databasePath: string
  identity: Pick<StorageCommand, 'dataGeneration' | 'actorId' | 'commandId'>
}) {
  if (!isAbsolute(options.databasePath))
    throw new TypeError('Receipt verification requires an existing absolute database path')
  const database = new DatabaseSync(options.databasePath, { readOnly: true })
  try {
    if (database.prepare('PRAGMA user_version').get()!.user_version !== BUDDY_MIGRATION_SCHEMA_VERSION)
      throw new Error('Receipt verification requires the supported storage schema')
    requireSqliteAuthority(database)
    return new CommandCommitter(database).find(options.identity)
  }
  finally {
    database.close()
  }
}
