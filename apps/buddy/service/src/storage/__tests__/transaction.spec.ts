import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterTransactionCommit, BuddyTransactionUncertainError, readTransactionFailure, withTransaction } from '../transaction'

const databases: SqliteDatabase[] = []
const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function open(databasePath = ':memory:'): SqliteDatabase {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value BLOB)')
  databases.push(database)
  return database
}

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-transaction-'))
  directories.push(directory)
  return join(directory, 'candidate.sqlite3')
}

function capture(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error('Expected operation to fail')
}

describe('storage transactions', () => {
  it('joins the caller transaction and commits all repository writes once', () => {
    const database = open()
    const value = withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      return withTransaction(database, () => {
        database.exec('INSERT INTO entries VALUES (2, NULL)')
        return 'accepted'
      })
    })
    expect(value).toBe('accepted')
    expect(database.isTransaction).toBe(false)
    expect(database.prepare('SELECT id FROM entries ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('rolls back all writes even when the caller catches a participant failure', () => {
    const database = open()
    const original = new Error('intent conflicts')
    const failure = capture(() => withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      expect(capture(() => withTransaction(database, () => {
        database.exec('INSERT INTO entries VALUES (2, NULL)')
        throw original
      }))).toBe(original)
      database.exec('INSERT INTO entries VALUES (3, NULL)')
    }))
    expect(failure).toBe(original)
    expect(readTransactionFailure(failure)).toEqual({ phase: 'operation', outcome: 'rolled_back' })
    expect(database.prepare('SELECT * FROM entries').all()).toEqual([])
    withTransaction(database, () => database.exec('INSERT INTO entries VALUES (4, NULL)'))
    expect(database.prepare('SELECT id FROM entries').all()).toEqual([{ id: 4 }])
  })

  it('does not adopt or roll back an unmanaged transaction', () => {
    const database = open()
    database.exec('BEGIN; INSERT INTO entries VALUES (1, NULL)')
    expect(() => withTransaction(database, () => database.exec('INSERT INTO entries VALUES (2, NULL)'))).toThrow('owned by withTransaction')
    expect(database.isTransaction).toBe(true)
    database.exec('COMMIT')
    expect(database.prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }])
  })

  it('retains SQLITE_FULL after SQLite automatically rolls back the transaction', () => {
    const database = open(temporaryPath())
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
    const pages = database.prepare('PRAGMA page_count').get() as { page_count: number }
    database.exec(`PRAGMA max_page_count = ${pages.page_count + 1}`)
    const failure = capture(() => withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      database.exec('INSERT INTO entries VALUES (2, zeroblob(1048576))')
    }))
    expect(failure).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 13 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'operation', outcome: 'rolled_back' })
    expect(database.isTransaction).toBe(false)
    expect(database.prepare('SELECT * FROM entries').all()).toEqual([])
    withTransaction(database, () => database.exec('INSERT INTO entries VALUES (1, NULL)'))
  })

  it('retains BEGIN BUSY without rolling back another connection', () => {
    const databasePath = temporaryPath()
    const database = open(databasePath)
    const writer = open(databasePath)
    writer.exec('BEGIN IMMEDIATE; INSERT INTO entries VALUES (1, NULL)')
    const failure = capture(() => withTransaction(database, () => database.exec('INSERT INTO entries VALUES (2, NULL)')))
    expect(failure).toMatchObject({ errcode: 5 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'begin', outcome: 'not_started' })
    expect(writer.isTransaction).toBe(true)
    writer.exec('COMMIT')
    expect(database.prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }])
  })

  it('closes an auto-rolled-back participant connection before a caught failure can leak autocommit writes', () => {
    const databasePath = temporaryPath()
    const database = open(databasePath)
    const pages = database.prepare('PRAGMA page_count').get() as { page_count: number }
    database.exec(`PRAGMA max_page_count = ${pages.page_count + 1}`)
    const failure = capture(() => withTransaction(database, () => {
      expect(capture(() => withTransaction(database, () => {
        database.exec('INSERT INTO entries VALUES (1, zeroblob(1048576))')
      }))).toMatchObject({ errcode: 13 })
      database.exec('INSERT INTO entries VALUES (2, NULL)')
    }))
    expect(failure).toMatchObject({ errcode: 13 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'operation', outcome: 'rolled_back' })
    expect(database.isOpen).toBe(false)
    expect(open(databasePath).prepare('SELECT * FROM entries').all()).toEqual([])
  })

  it('rolls back COMMIT BUSY and never publishes an acceptance', () => {
    const databasePath = temporaryPath()
    const database = open(databasePath)
    const reader = open(databasePath)
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM entries').all()
    const notifications: string[] = []
    const failure = capture(() => withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      afterTransactionCommit(database, () => notifications.push('accepted'), () => {})
    }))
    expect(failure).toMatchObject({ errcode: 5 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'commit', outcome: 'rolled_back' })
    expect(database.isTransaction).toBe(false)
    reader.exec('COMMIT')
    expect(database.prepare('SELECT * FROM entries').all()).toEqual([])
    expect(notifications).toEqual([])
    withTransaction(database, () => database.exec('INSERT INTO entries VALUES (1, NULL)'))
  })

  it('retains the original error and blocks subsequent transactions if rollback is denied', () => {
    const database = open()
    database.setAuthorizer((action, operation) => action === constants.SQLITE_TRANSACTION && operation === 'ROLLBACK' ? constants.SQLITE_DENY : constants.SQLITE_OK)
    const original = new Error('write failed')
    const failure = capture(() => withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      throw original
    }))
    expect(failure).toBeInstanceOf(BuddyTransactionUncertainError)
    expect(failure).toMatchObject({ cause: original })
    expect(readTransactionFailure(failure)).toMatchObject({ phase: 'operation', outcome: 'unknown', cleanupError: { errcode: 23 } })
    expect(capture(() => withTransaction(database, () => database.exec('INSERT INTO entries VALUES (2, NULL)')))).toBe(failure)
    expect(database.prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }])
    database.setAuthorizer(null)
    database.exec('ROLLBACK')
    expect(capture(() => withTransaction(database, () => {}))).toBe(failure)
  })

  it('requires a new connection to verify a commit that succeeded before an injected error', () => {
    const databasePath = temporaryPath()
    const database = open(databasePath)
    const exec = database.exec.bind(database)
    const original = new Error('injected failure after COMMIT')
    vi.spyOn(database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw original
    })
    const notifications: string[] = []
    const failure = capture(() => withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      afterTransactionCommit(database, () => notifications.push('accepted'), () => {})
    }))
    expect(failure).toBeInstanceOf(BuddyTransactionUncertainError)
    expect(failure).toMatchObject({ cause: original })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'commit', outcome: 'unknown' })
    expect(capture(() => withTransaction(database, () => database.exec('INSERT INTO entries VALUES (2, NULL)')))).toBe(failure)
    expect(notifications).toEqual([])
    database.close()
    expect(open(databasePath).prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }])
  })

  it('rejects async callbacks before their body runs and rolls back returned promises', async () => {
    const database = open()
    const asyncOperation = async () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
    }
    // @ts-expect-error Transaction callbacks cannot be asynchronous.
    expect(() => withTransaction(database, asyncOperation)).toThrow('synchronous')
    const returnsPromise = () => {
      database.exec('INSERT INTO entries VALUES (2, NULL)')
      return Promise.reject(new Error('late failure'))
    }
    // @ts-expect-error Thenable results cannot escape the transaction.
    expect(() => withTransaction(database, returnsPromise)).toThrow('promise')
    await Promise.resolve()
    expect(database.prepare('SELECT * FROM entries').all()).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it('publishes after the outer commit in FIFO order even when an observer starts another transaction', async () => {
    const database = open()
    const notifications: number[] = []
    const errors: unknown[] = []
    const original = new Error('observer failed')
    const notify = (id: number) => afterTransactionCommit(database, () => {
      expect(database.isTransaction).toBe(false)
      expect(database.prepare('SELECT id FROM entries WHERE id = ?').get(id)).toEqual({ id })
      notifications.push(id)
      if (id === 1) {
        withTransaction(database, () => {
          database.exec('INSERT INTO entries VALUES (3, NULL)')
          notify(3)
        })
        throw original
      }
      if (id === 2)
        return Promise.reject(original)
    }, error => errors.push(error))
    withTransaction(database, () => {
      database.exec('INSERT INTO entries VALUES (1, NULL)')
      notify(1)
      withTransaction(database, () => {
        database.exec('INSERT INTO entries VALUES (2, NULL)')
        notify(2)
      })
      expect(notifications).toEqual([])
    })
    await Promise.resolve()
    expect(notifications).toEqual([1, 2, 3])
    expect(errors).toEqual([original, original])
    expect(database.prepare('SELECT id FROM entries ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })
})
