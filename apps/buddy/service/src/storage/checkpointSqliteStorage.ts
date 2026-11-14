import type { DatabaseSync } from 'node:sqlite'
import { requireSqliteAuthority } from './sqliteAuthority'
import { getStorageIsolation } from './StorageIsolation'
import { assertCommittedRead } from './transaction'

export interface SqliteCheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

export function checkpointSqliteStorage(database: DatabaseSync): SqliteCheckpointResult {
  assertCommittedRead(database)
  requireSqliteAuthority(database)
  const isolation = getStorageIsolation(database)
  const timeout = database.prepare('PRAGMA busy_timeout').get()!.timeout as number
  try {
    database.exec('PRAGMA busy_timeout = 0')
    const result = database.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get() as unknown as SqliteCheckpointResult
    database.exec(`PRAGMA busy_timeout = ${timeout}`)
    return result
  }
  catch (cause) {
    isolation.isolate(cause)
    throw cause
  }
}
