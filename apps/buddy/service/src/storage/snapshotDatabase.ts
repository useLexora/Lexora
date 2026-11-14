import type { SQLInputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { storageError, syncStorageDirectory, syncStorageFile } from '../../../platform/storage/storageFiles'
import { openBuddyDatabase, openBuddySqliteDatabase } from './database'
import { BUDDY_MIGRATION_SCHEMA_VERSION, BUDDY_SCHEMA_VERSION } from './schema'

export function snapshotDatabaseVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return Number(database.prepare('PRAGMA user_version').get()!.user_version)
  }
  finally { database.close() }
}

export function openSnapshotDatabase(databasePath: string): DatabaseSync {
  const version = snapshotDatabaseVersion(databasePath)
  if (version <= BUDDY_SCHEMA_VERSION)
    return openBuddyDatabase({ databasePath })
  return openBuddySqliteDatabase({ databasePath })
}

export async function rewriteIsolatedSnapshotDatabase<T>(databasePath: string, operation: (database: DatabaseSync) => T | Promise<T>): Promise<T> {
  const source = openSnapshotDatabase(databasePath)
  if (Number(source.prepare('PRAGMA user_version').get()!.user_version) <= BUDDY_SCHEMA_VERSION) {
    try {
      return await operation(source)
    }
    finally { source.close() }
  }
  const temporary = join(dirname(databasePath), `.snapshot-${randomUUID()}.sqlite3`)
  let database: DatabaseSync | undefined
  try {
    closeSync(openSync(temporary, 'wx', 0o600))
    database = new DatabaseSync(temporary)
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA synchronous = FULL; BEGIN IMMEDIATE')
    const schema = source.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE \'sqlite_%\' ORDER BY type, name').all() as Array<{ type: string, name: string, sql: string }>
    for (const definition of schema.filter(item => item.type === 'table'))
      database.exec(definition.sql)
    for (const definition of schema.filter(item => item.type === 'index'))
      database.exec(definition.sql)
    for (const { name } of schema.filter(item => item.type === 'table')) {
      const names = (source.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(column => column.name)
      const insert = database.prepare(`INSERT INTO ${quote(name)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      const rows = source.prepare(`SELECT * FROM ${quote(name)}`)
      rows.setReadBigInts(true)
      for (const row of rows.iterate())
        insert.run(...names.map(column => row[column] as SQLInputValue))
    }
    if (source.prepare('SELECT 1 FROM sqlite_master WHERE name = \'sqlite_sequence\'').get()) {
      const sequences = source.prepare('SELECT name, seq FROM sqlite_sequence')
      sequences.setReadBigInts(true)
      database.exec('DELETE FROM sqlite_sequence')
      const insertSequence = database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
      for (const row of sequences.iterate())
        insertSequence.run(row.name!, row.seq!)
    }
    database.exec(`PRAGMA user_version = ${BUDDY_MIGRATION_SCHEMA_VERSION}; COMMIT; PRAGMA foreign_keys = ON`)
    const result = await operation(database)
    database.exec('BEGIN IMMEDIATE')
    for (const definition of schema.filter(item => item.type === 'trigger' || item.type === 'view'))
      database.exec(definition.sql)
    if (database.prepare('PRAGMA foreign_key_check').all().length || database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
      throw storageError('SNAPSHOT_DATABASE_INVALID')
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    database.close()
    database = undefined
    source.close()
    const verified = openBuddySqliteDatabase({ databasePath: temporary })
    verified.close()
    await syncStorageFile(temporary)
    await Promise.all([rm(`${databasePath}-wal`, { force: true }), rm(`${databasePath}-shm`, { force: true })])
    await rename(temporary, databasePath)
    await syncStorageDirectory(dirname(databasePath))
    return result
  }
  finally {
    if (source.isOpen)
      source.close()
    if (database?.isOpen)
      database.close()
    await Promise.all([temporary, `${temporary}-wal`, `${temporary}-shm`].map(path => rm(path, { force: true })))
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
