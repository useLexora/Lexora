import type { BuddySchemaMigration } from '../schema'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../database'
import { BUDDY_SCHEMA_MIGRATIONS } from '../schema'
import { EXPERIMENTAL_PERSISTENCE_SCHEMA_SQL } from './experimentalPersistenceSchema'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from './migrationFixture'

const roots: string[] = []
const databases: DatabaseSync[] = []
const now = '2026-11-09T00:00:00.000Z'

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lexora-archive-schema-'))
  roots.push(root)
  const databasePath = join(root, 'buddy.sqlite3')
  const database = openMigrationFixtureDatabase(databasePath)
  databases.push(database)
  apply(database, BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 41))
  return { root, databasePath, database }
}

function apply(database: DatabaseSync, migrations: readonly BuddySchemaMigration[]) {
  for (const migration of migrations) {
    database.exec(migration.sql)
    database.exec(`PRAGMA user_version = ${migration.version}`)
  }
}

function snapshot(database: DatabaseSync, columns?: Record<string, string[]>) {
  const names = columns ?? Object.fromEntries(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all().map(({ name }) => [String(name), database.prepare(`PRAGMA table_info("${name}")`).all().map(column => String(column.name))]))
  return {
    columns: names,
    rows: Object.fromEntries(Object.entries(names).map(([table, fields]) => [table, database.prepare(`SELECT ${fields.map(field => `"${field}"`).join(', ')} FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()])),
  }
}

function seed(database: DatabaseSync, sessionFile: string) {
  database.exec(`
    INSERT INTO conversations (id, title, deleted_at, created_at, updated_at) VALUES
      ('task', 'Keep task', NULL, '${now}', '${now}'),
      ('removed', 'Legacy tombstone', '${now}', '${now}', '${now}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch', 'task', '${now}');
    UPDATE conversations SET active_branch_id = 'branch' WHERE id = 'task';
    INSERT INTO conversation_members (conversation_id, actor_id, joined_at) VALUES ('task', 'default', '${now}');
    INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
      VALUES ('input', 'task', 'branch', 'user', '{"text":"Keep input"}', '${now}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'completed', '${now}');
    INSERT INTO extension_invocations (id, extension_id, action_id, conversation_id, trigger, status, started_at)
      VALUES ('invocation', 'fixture', 'fixture', 'task', 'user', 'completed', '${now}');
    INSERT INTO usage_records (id, run_id, invocation_id, source_entry_id, provider, model, purpose,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at)
      VALUES ('usage-run', 'run', NULL, 'entry', 'fixture', 'fixture', 'chat', 1, 2, 3, 4, 10, 1, 2, 3, 4, 10, '${now}'),
        ('usage-action', NULL, 'invocation', 'entry', 'fixture', 'fixture', 'extension.action', 1, 2, 3, 4, 10, 1, 2, 3, 4, 10, '${now}');
  `)
  database.prepare('UPDATE runs SET pi_session_file = ?').run(sessionFile)
  database.prepare('INSERT INTO conversation_pi_trees (conversation_id, session_file, root_entry_id) VALUES (?, ?, ?)').run('task', sessionFile, 'root')
}

function open(databasePath: string) {
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  return database
}

describe('archive schema lineage', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  it('upgrades the real v41 database in place without importing JSONL, altering external files or scheduling old tombstones', () => {
    const { root, databasePath, database: previous } = fixture()
    const external = mkdtempSync(join(tmpdir(), 'lexora-archive-external-'))
    roots.push(external)
    mkdirSync(join(root, 'runs'))
    const eventFile = join(root, 'runs', 'run.jsonl')
    const sessionFile = join(external, 'session.jsonl')
    writeFileSync(eventFile, '{"sequence":1,"type":"run.completed"}\n')
    writeFileSync(sessionFile, '{"id":"root","type":"session","preserved":true}\n')
    seed(previous, sessionFile)
    const before = snapshot(previous)
    previous.close()
    const inode = statSync(databasePath).ino
    const files = [eventFile, sessionFile].map(path => ({ path, bytes: readFileSync(path), mtime: statSync(path).mtimeMs }))
    const upgraded = open(databasePath)
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(42)
    expect(statSync(databasePath).ino).toBe(inode)
    expect(snapshot(upgraded, before.columns)).toEqual(before)
    expect(upgraded.prepare('SELECT name FROM sqlite_master WHERE name IN (\'storage_profile\', \'managed_files\', \'product_content_references\')').all()).toEqual([])
    expect(upgraded.prepare('SELECT archived_at, metadata_revision FROM conversations').all()).toEqual([{ archived_at: null, metadata_revision: 0 }, { archived_at: null, metadata_revision: 0 }])
    expect(upgraded.prepare('SELECT * FROM conversation_archive_policy').all()).toEqual([{ id: 1, days: 0 }])
    expect(upgraded.prepare('SELECT * FROM conversation_deletion_jobs').all()).toEqual([])
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(upgraded.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    for (const file of files) {
      expect(readFileSync(file.path)).toEqual(file.bytes)
      expect(statSync(file.path).mtimeMs).toBe(file.mtime)
    }
    expect(readdirSync(external)).toEqual(['session.jsonl'])
  })

  it('persists archive CAS, admission guards, deletion jobs and detached usage on the legacy schema', () => {
    const { databasePath, database: previous } = fixture()
    seed(previous, '/synthetic/session.jsonl')
    previous.close()
    const database = open(databasePath)
    database.exec(`UPDATE conversations SET archived_at = '${now}' WHERE id = 'task'`)
    expect(database.prepare('SELECT metadata_revision FROM conversations WHERE id = \'task\'').get()?.metadata_revision).toBe(1)
    database.exec(`UPDATE conversation_members SET removed_at = '${now}' WHERE conversation_id = 'task'`)
    expect(database.prepare('SELECT metadata_revision FROM conversations WHERE id = \'task\'').get()?.metadata_revision).toBe(2)
    expect(database.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ? AND metadata_revision = ?').run('task', 0).changes).toBe(0)
    expect(() => database.exec('UPDATE runs SET status = \'queued\' WHERE id = \'run\'')).toThrow('CONVERSATION_NOT_ACTIVE')
    expect(() => database.exec(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('blocked', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'queued', '${now}')`)).toThrow('CONVERSATION_NOT_ACTIVE')
    database.exec(`INSERT INTO conversation_deletion_jobs VALUES ('task', 'failed', 'conversation', 'RETRY_REQUIRED', '{"files":[]}', '${now}', '${now}')`)
    database.exec('DELETE FROM runs; DELETE FROM extension_invocations')
    const retainedUsage = database.prepare('SELECT id, run_id, invocation_id, detached, total_tokens, total_cost FROM usage_records ORDER BY id').all()
    expect(retainedUsage).toEqual(['usage-action', 'usage-run'].map(id => ({ id, run_id: null, invocation_id: null, detached: 1, total_tokens: 10, total_cost: 10 })))
    database.close()
    const reopened = open(databasePath)
    expect(reopened.prepare('SELECT status, origin, error_code, manifest_json FROM conversation_deletion_jobs').get()).toEqual({ status: 'failed', origin: 'conversation', error_code: 'RETRY_REQUIRED', manifest_json: '{"files":[]}' })
    expect(reopened.prepare('SELECT id, run_id, invocation_id, detached, total_tokens, total_cost FROM usage_records ORDER BY id').all()).toEqual(retainedUsage)
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each([false, true])('rejects experimental v42 before changing database or WAL bytes (live WAL=%s)', (wal) => {
    const { databasePath, database } = fixture()
    seed(database, '/synthetic/session.jsonl')
    database.exec(EXPERIMENTAL_PERSISTENCE_SCHEMA_SQL)
    database.exec('PRAGMA user_version = 42')
    if (wal) {
      database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
      database.exec('UPDATE conversations SET title = \'Keep committed WAL data\' WHERE id = \'task\'')
    }
    else {
      database.close()
    }
    const paths = wal ? [databasePath, `${databasePath}-wal`] : [databasePath]
    const original = paths.map(path => readFileSync(path))
    expect(() => openBuddyDatabase({ databasePath })).toThrowError(expect.objectContaining({ name: 'BuddyDatabaseVersionError', reason: 'incompatible schema lineage' }))
    paths.forEach((path, index) => expect(readFileSync(path).equals(original[index]!)).toBe(true))
    const check = new DatabaseSync(databasePath, { readOnly: true })
    databases.push(check)
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(42)
    expect(check.prepare('SELECT title FROM conversations WHERE id = \'task\'').get()?.title).toBe(wal ? 'Keep committed WAL data' : 'Keep task')
  })

  it.each([43, 44, 45, 46, 47, 48, 49])('rejects future schema v%s without changing its bytes', (version) => {
    const { databasePath, database } = fixture()
    database.exec(`PRAGMA user_version = ${version}`)
    database.close()
    const original = readFileSync(databasePath)
    expect(() => openBuddyDatabase({ databasePath })).toThrow('newer schema version')
    expect(readFileSync(databasePath).equals(original)).toBe(true)
  })
})
