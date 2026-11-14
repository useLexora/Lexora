import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteRunEventLog } from '../../events/SqliteRunEventLog'
import { SqliteRunEventWriter } from '../../events/SqliteRunEventWriter'
import { checkpointSqliteStorage } from '../checkpointSqliteStorage'
import { openBuddyMigrationCandidate } from '../database'
import { getStorageIsolation, guardStorageDatabase } from '../StorageIsolation'
import { seedSqliteRun } from './sqliteRunFixture'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-sqlite-checkpoint-'))
  directories.push(directory)
  const databasePath = join(directory, 'candidate.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath })
  databases.push(database)
  guardStorageDatabase(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'run-1')
  const writer = new SqliteRunEventWriter(database)
  const append = () => writer.append({ runId: 'run-1', type: 'message.delta', payload: { messageId: 'answer', delta: 'x'.repeat(8192) } })
  return { databasePath, database, append, walSize: () => statSync(`${databasePath}-wal`).size }
}

describe('candidate SQLite durability', () => {
  it('returns busy for a real long reader, keeps accepting writes and reclaims after release', () => {
    const f = fixture()
    f.append()
    const reader = new DatabaseSync(f.databasePath, { readOnly: true })
    databases.push(reader)
    reader.exec('BEGIN')
    expect(reader.prepare('SELECT count(*) AS count FROM run_events').get()).toEqual({ count: 1 })
    f.append()
    const started = performance.now()
    const result = checkpointSqliteStorage(f.database)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.busy).toBe(1)
    expect(result.log).toBeGreaterThan(result.checkpointed)
    expect(f.walSize()).toBeGreaterThan(0)
    expect(getStorageIsolation(f.database).failure).toBeNull()
    expect(f.database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    expect(f.append().sequence).toBe(3)
    expect(reader.prepare('SELECT count(*) AS count FROM run_events').get()).toEqual({ count: 1 })
    reader.exec('ROLLBACK')
    expect(checkpointSqliteStorage(f.database).busy).toBe(0)
    expect(f.walSize()).toBe(0)
    expect(f.database.prepare('SELECT count(*) AS count FROM run_events').get()).toEqual({ count: 3 })
  })

  it('refuses checkpoint inside a business transaction without poisoning the connection', () => {
    const f = fixture()
    f.database.exec('BEGIN')
    expect(() => checkpointSqliteStorage(f.database)).toThrow('transaction')
    f.database.exec('ROLLBACK')
    expect(getStorageIsolation(f.database).failure).toBeNull()
    expect(checkpointSqliteStorage(f.database).busy).toBe(0)
  })

  it('reclaims the WAL when the healthy SQLite event log closes', async () => {
    const f = fixture()
    const log = new SqliteRunEventLog({ database: f.database })
    await log.append({ runId: 'run-1', type: 'run.started', payload: null })
    expect(f.walSize()).toBeGreaterThan(0)
    await log.close()
    await log.close()
    expect(log.state).toBe('closed')
    expect(f.walSize()).toBe(0)
    expect(f.database.prepare('SELECT status FROM runs').get()).toEqual({ status: 'running' })
  })

  it('isolates a real read-only checkpoint failure and preserves its original error', () => {
    const f = fixture()
    f.append()
    const reader = new DatabaseSync(f.databasePath, { readOnly: true })
    databases.push(reader)
    const isolation = guardStorageDatabase(reader)
    let error: unknown
    try {
      checkpointSqliteStorage(reader)
    }
    catch (cause) {
      error = cause
    }
    expect(error).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: expect.any(Number) })
    expect(isolation.failure?.cause).toBe(error)
    expect(f.database.prepare('SELECT count(*) AS count FROM run_events').get()).toEqual({ count: 1 })
  })
})
