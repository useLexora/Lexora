import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { openBuddyDatabase, openBuddyMigrationCandidate, openBuddySqliteDatabase } from '../database'
import { BUDDY_MIGRATION_SCHEMA_VERSION, BUDDY_SCHEMA_VERSION } from '../schema'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function path() {
  const root = mkdtempSync(join(tmpdir(), 'lexora-sqlite-startup-'))
  roots.push(root)
  return join(root, 'buddy.sqlite3')
}

it('initializes a new database with ready authority and FULL durability, then reopens the same generation', () => {
  const databasePath = path()
  const database = openBuddySqliteDatabase({ databasePath })
  const identity = database.prepare('SELECT * FROM storage_profile').get()
  expect(identity).toMatchObject({ authority: 'sqlite', migration_state: 'ready' })
  expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(BUDDY_MIGRATION_SCHEMA_VERSION)
  expect(database.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
  expect(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  database.close()
  const reopened = openBuddySqliteDatabase({ databasePath })
  try {
    expect(reopened.prepare('SELECT * FROM storage_profile').get()).toEqual(identity)
  }
  finally { reopened.close() }
})

it('refuses a legacy profile before changing its schema or bytes', () => {
  const databasePath = path()
  const legacy = openBuddyDatabase({ databasePath })
  legacy.close()
  const original = readFileSync(databasePath)
  expect(() => openBuddySqliteDatabase({ databasePath })).toThrow('explicit persistence migration required')
  expect(readFileSync(databasePath)).toEqual(original)
  const reopened = openBuddyDatabase({ databasePath })
  try {
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(BUDDY_SCHEMA_VERSION)
  }
  finally { reopened.close() }
})

it('does not activate an unfinished candidate even when it contains no tasks', () => {
  const databasePath = path()
  const pending = openBuddyMigrationCandidate({ databasePath })
  pending.close()
  const original = readFileSync(databasePath)
  expect(() => openBuddySqliteDatabase({ databasePath })).toThrow('authority is not ready')
  expect(readFileSync(databasePath)).toEqual(original)
})

it('does not initialize an unversioned file containing existing tables', () => {
  const databasePath = path()
  const unknown = new DatabaseSync(databasePath)
  unknown.exec('CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES (\'existing user data\')')
  unknown.close()
  const original = readFileSync(databasePath)
  expect(() => openBuddySqliteDatabase({ databasePath })).toThrow('unversioned schema')
  expect(readFileSync(databasePath)).toEqual(original)
})

it('rejects a live legacy WAL without checkpointing or changing its committed bytes', () => {
  const databasePath = path()
  const legacy = openBuddyDatabase({ databasePath })
  try {
    legacy.exec('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (\'preserved\', \'Keep WAL data\', \'2026-11-07\', \'2026-11-07\')')
    const databaseBytes = readFileSync(databasePath)
    const journalBytes = readFileSync(`${databasePath}-wal`)
    expect(journalBytes.length).toBeGreaterThan(0)
    expect(() => openBuddySqliteDatabase({ databasePath })).toThrow('explicit persistence migration required')
    expect(readFileSync(databasePath)).toEqual(databaseBytes)
    expect(readFileSync(`${databasePath}-wal`)).toEqual(journalBytes)
    expect(legacy.prepare('SELECT title FROM conversations WHERE id = ?').get('preserved')?.title).toBe('Keep WAL data')
  }
  finally { legacy.close() }
})
