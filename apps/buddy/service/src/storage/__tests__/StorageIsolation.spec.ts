import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { guardStorageDatabase, StorageIsolatedError } from '../StorageIsolation'
import { withTransaction } from '../transaction'

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

function open(path = ':memory:') {
  const database = new DatabaseSync(path)
  databases.push(database)
  return database
}

describe('storage isolation', () => {
  it('isolates all prepared reads and writes on real READONLY failure while allowing rollback and close', () => {
    const database = open()
    const isolation = guardStorageDatabase(database)
    database.exec('CREATE TABLE values_table (value TEXT); INSERT INTO values_table VALUES (\'original\')')
    const read = database.prepare('SELECT * FROM values_table')
    const write = database.prepare('INSERT INTO values_table VALUES (?)')
    const iterator = read.iterate()
    expect(iterator.next().value).toEqual({ value: 'original' })
    database.exec('PRAGMA query_only = ON; BEGIN')
    const failures: unknown[] = []
    isolation.onDidIsolate(error => failures.push(error))
    expect(() => write.run('lost')).toThrow(expect.objectContaining({ errcode: 8 }))
    expect(database.isTransaction).toBe(true)
    const failure = isolation.failure
    for (const operation of [() => read.get(), () => read.all(), () => iterator.next(), () => write.run('retry'), () => database.exec('SELECT 1'), () => database.prepare('SELECT 1'), () => withTransaction(database, () => 1)])
      expect(operation).toThrow(StorageIsolatedError)
    isolation.isolate(new Error('secondary failure'))
    expect(isolation.failure).toBe(failure)
    expect(failures).toEqual([failure])
    database.exec('ROLLBACK')
    expect(database.isTransaction).toBe(false)
    database.close()
    expect(database.isOpen).toBe(false)
  })

  it('isolates a real FULL failure even when SQLite has already rolled the transaction back', () => {
    const database = open()
    const isolation = guardStorageDatabase(database)
    database.exec('CREATE TABLE values_table (value BLOB)')
    const pages = Number(database.prepare('PRAGMA page_count').get()!.page_count)
    database.exec(`PRAGMA max_page_count = ${pages}`)
    expect(() => withTransaction(database, () => database.prepare('INSERT INTO values_table VALUES (zeroblob(1048576))').run()))
      .toThrow(expect.objectContaining({ errcode: 13 }))
    expect(database.isTransaction).toBe(false)
    expect(isolation.failure?.cause).toMatchObject({ errcode: 13 })
    expect(() => database.prepare('SELECT * FROM values_table')).toThrow(StorageIsolatedError)
  })

  it('isolates an unreadable database instead of returning empty results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-storage-unreadable-'))
    directories.push(directory)
    const path = join(directory, 'broken.sqlite3')
    writeFileSync(path, 'not a SQLite database'.repeat(64))
    const database = open(path)
    const isolation = guardStorageDatabase(database)
    expect(() => database.prepare('SELECT * FROM sqlite_schema').all()).toThrow(expect.objectContaining({ errcode: 26 }))
    expect(isolation.failure?.cause).toMatchObject({ errcode: 26 })
  })

  it('keeps a known constraint rollback usable', () => {
    const database = open()
    const isolation = guardStorageDatabase(database)
    database.exec('CREATE TABLE values_table (id INTEGER PRIMARY KEY); INSERT INTO values_table VALUES (1)')
    expect(() => withTransaction(database, () => database.prepare('INSERT INTO values_table VALUES (1)').run())).toThrow()
    expect(isolation.failure).toBeNull()
    withTransaction(database, () => database.prepare('INSERT INTO values_table VALUES (2)').run())
    expect(database.prepare('SELECT id FROM values_table ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
  })
})
