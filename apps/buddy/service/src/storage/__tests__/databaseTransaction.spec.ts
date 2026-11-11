import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { withTransaction } from '../database'

const databases: DatabaseSync[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lexora-transaction-'))
  roots.push(root)
  const path = join(root, 'database.sqlite3')
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec('CREATE TABLE ledger (value TEXT UNIQUE)')
  const insert = (value: string) => database.prepare('INSERT INTO ledger VALUES (?)').run(value)
  const persisted = () => {
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      return reader.prepare('SELECT value FROM ledger ORDER BY value').all()
    }
    finally { reader.close() }
  }
  return { database, insert, persisted }
}

it('commits nested writes exactly once and returns the synchronous result', () => {
  const { database, insert, persisted } = fixture()
  expect(withTransaction(database, () => {
    insert('outer')
    expect(withTransaction(database, () => {
      insert('inner')
      return 'nested-result'
    })).toBe('nested-result')
    expect(persisted()).toEqual([])
    return 42
  })).toBe(42)
  expect(persisted()).toEqual([{ value: 'inner' }, { value: 'outer' }])
  expect(database.isTransaction).toBe(false)
})

it.each([new Error('inner failure'), undefined])('rolls back the outer transaction when a caught inner operation fails (%s)', (failure) => {
  const { database, insert, persisted } = fixture()
  let thrown = false
  try {
    withTransaction(database, () => {
      insert('before')
      try {
        withTransaction(database, () => {
          insert('inner')
          throw failure
        })
      }
      catch {}
      insert('after-catch')
    })
  }
  catch (error) {
    thrown = true
    expect(error).toBe(failure)
  }
  expect(thrown).toBe(true)
  expect(persisted()).toEqual([])
  withTransaction(database, () => insert('recovered'))
  expect(persisted()).toEqual([{ value: 'recovered' }])
})

it('keeps SAVEPOINT rollback and deferred foreign-key commits inside the outer transaction', () => {
  const { database } = fixture()
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))')
  withTransaction(database, () => {
    database.exec('PRAGMA defer_foreign_keys = ON; SAVEPOINT probe')
    database.exec('INSERT INTO child VALUES (1)')
    database.exec('ROLLBACK TO probe; RELEASE probe')
    withTransaction(database, () => database.exec('INSERT INTO child VALUES (2)'))
    database.exec('INSERT INTO parent VALUES (2)')
  })
  expect(database.prepare('SELECT * FROM child').all()).toEqual([{ parent_id: 2 }])
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('rolls back a failed deferred constraint commit and leaves a confirmed-clean connection writable', () => {
  const { database, insert, persisted } = fixture()
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
  expect(() => withTransaction(database, () => {
    insert('must-rollback')
    database.exec('INSERT INTO child VALUES (1)')
  })).toThrow('FOREIGN KEY constraint failed')
  expect(persisted()).toEqual([])
  withTransaction(database, () => insert('recovered'))
  expect(persisted()).toEqual([{ value: 'recovered' }])
})

it('refuses an async callback before it can write', () => {
  const { database, insert, persisted } = fixture()
  const operation = (async () => {
    insert('forbidden')
  }) as unknown as () => void
  expect(() => withTransaction(database, operation)).toThrow('synchronous operations')
  expect(persisted()).toEqual([])
  withTransaction(database, () => insert('recovered'))
  expect(persisted()).toEqual([{ value: 'recovered' }])
})

it('rolls back a promise result and prevents its continuation from writing after rejection', async () => {
  const { database, insert, persisted } = fixture()
  let continuation: Promise<unknown> | undefined
  let lateError: unknown
  const operation = (() => {
    insert('before-await')
    continuation = Promise.resolve().then(() => insert('late')).catch((error: unknown) => {
      lateError = error
    })
    return continuation
  }) as unknown as () => void
  expect(() => withTransaction(database, operation)).toThrow('cannot return a promise')
  await continuation
  expect(lateError).toBeInstanceOf(Error)
  expect(database.isOpen).toBe(false)
  expect(() => insert('direct')).toThrow()
  expect(persisted()).toEqual([])
})

it('blocks direct writes after a nested SQLite automatic rollback even if its exception is caught', () => {
  const { database, insert, persisted } = fixture()
  expect(() => withTransaction(database, () => {
    insert('duplicate')
    try {
      withTransaction(database, () => database.exec('INSERT OR ROLLBACK INTO ledger VALUES (\'duplicate\')'))
    }
    catch {}
    expect(() => insert('after-auto-rollback')).toThrow()
  })).toThrowError(expect.objectContaining({ code: 'STORAGE_TRANSACTION_UNCERTAIN' }))
  expect(database.isOpen).toBe(false)
  expect(persisted()).toEqual([])
})

it('closes an uncertain connection after a commit that succeeded before its acknowledgement failed', () => {
  const { database, insert, persisted } = fixture()
  const execute = database.exec.bind(database)
  vi.spyOn(database, 'exec').mockImplementation((sql) => {
    execute(sql)
    if (sql === 'COMMIT')
      throw new Error('commit acknowledgement lost')
  })
  expect(() => withTransaction(database, () => insert('committed'))).toThrowError(expect.objectContaining({ code: 'STORAGE_TRANSACTION_UNCERTAIN' }))
  expect(database.isOpen).toBe(false)
  expect(() => insert('direct')).toThrow()
  expect(() => withTransaction(database, () => insert('wrapped'))).toThrowError(expect.objectContaining({ code: 'STORAGE_TRANSACTION_UNCERTAIN' }))
  expect(persisted()).toEqual([{ value: 'committed' }])
})

it('closes a connection when rollback fails and prevents subsequent writes', () => {
  const { database, insert, persisted } = fixture()
  const execute = database.exec.bind(database)
  vi.spyOn(database, 'exec').mockImplementation((sql) => {
    if (sql === 'ROLLBACK')
      throw new Error('rollback failed')
    execute(sql)
  })
  expect(() => withTransaction(database, () => {
    insert('uncommitted')
    throw new Error('operation failed')
  })).toThrowError(expect.objectContaining({ code: 'STORAGE_TRANSACTION_UNCERTAIN' }))
  expect(database.isOpen).toBe(false)
  expect(() => insert('direct')).toThrow()
  expect(() => withTransaction(database, () => insert('wrapped'))).toThrowError(expect.objectContaining({ code: 'STORAGE_TRANSACTION_UNCERTAIN' }))
  expect(persisted()).toEqual([])
})
