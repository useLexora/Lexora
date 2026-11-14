import type { SQLInputValue } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../database'
import { BUDDY_V43_PERSISTENCE_SCHEMA_SQL } from '../migrations/v43Persistence'
import { BUDDY_MIGRATION_SCHEMA_VERSION, BUDDY_SCHEMA_VERSION } from '../schema'
import { withTransaction } from '../transaction'
import { MIGRATION_TEST_TIMEOUT } from './migrationFixture'

const databases: DatabaseSync[] = []
const directories: string[] = []
const now = '2026-09-29T00:00:00.000Z'

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function candidate(databasePath = ':memory:'): DatabaseSync {
  const database = openBuddyMigrationCandidate({ databasePath })
  databases.push(database)
  return database
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-persistence-migration-'))
  directories.push(directory)
  const sourcePath = join(directory, 'source.sqlite3')
  const databasePath = join(directory, 'candidate.sqlite3')
  const source = openBuddyDatabase({ databasePath: sourcePath })
  databases.push(source)
  seed(source)
  const before = snapshot(source)
  source.close()
  const sourceHash = hash(sourcePath)
  copyFileSync(sourcePath, databasePath)
  return { sourcePath, sourceHash, databasePath, before }
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function snapshot(database: DatabaseSync, previous?: ReturnType<typeof tableColumns>) {
  const columns = previous ?? tableColumns(database)
  return {
    columns,
    tables: Object.fromEntries(Object.entries(columns).map(([table, names]) => [
      table,
      database.prepare(`SELECT ${names.map(name => `"${name}"`).join(', ')} FROM "${table}"`).all().map(row => JSON.stringify(row)).sort(),
    ])),
  }
}

function tableColumns(database: DatabaseSync): Record<string, string[]> {
  const tables = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' AND name <> \'buddy_schema_lineage\' ORDER BY name').all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name, (database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(column => column.name)]))
}

function seed(database: DatabaseSync): void {
  withTransaction(database, () => database.exec(`
    INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('task', 'Keep task', '${now}', '${now}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch', 'task', '${now}');
    UPDATE conversations SET active_branch_id = 'branch';
    INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
      VALUES ('input', 'task', 'branch', 'user', '{"text":"Keep input"}', '${now}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'completed', '${now}');
    INSERT INTO run_inputs (run_id, prompt, attachment_ids_json, context_items_json, created_at)
      VALUES ('run', 'Keep original input', '[]', '[]', '${now}');
    INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
      VALUES ('run', 1, 'run.started', '{}', '${now}'),
        ('run', 4, 'future.unknown', '{"keep":true}', '${now}'),
        ('run', 5, 'run.completed', '{}', '${now}');
    INSERT INTO composer_drafts (id, scope_kind, revision, content_json, approval_policy, execution_profile, created_at, updated_at)
      VALUES ('draft-one', 'task', 7, '{"uninterpreted":"Keep draft one"}', 'policy', 'workspace_write', '${now}', '${now}'),
        ('draft-two', 'task', 9, '{"uninterpreted":"Keep draft two"}', 'policy', 'read_only', '${now}', '${now}');
    INSERT INTO turn_requests (request_id, request_fingerprint, conversation_id, branch_id, run_id, created_at)
      VALUES ('same-legacy-id', 'turn-intent', 'task', 'branch', 'run', '${now}');
    INSERT INTO command_requests (request_id, request_fingerprint, conversation_id, branch_id, run_id, command, arguments, created_at)
      VALUES ('same-legacy-id', 'compact-intent', 'task', 'branch', 'run', 'compact', '', '${now}');
    INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('queue', 'task', 'branch', 'same-legacy-id', 'queue-intent', '{}', 'paused', '${now}');
  `))
}

function addReceipt(database: DatabaseSync, overrides: Record<string, SQLInputValue> = {}, insert = 'INSERT'): void {
  const values = {
    data_generation: (database.prepare('SELECT data_generation FROM storage_profile').get() as { data_generation: string }).data_generation,
    actor_id: 'desktop-local',
    command_id: 'command',
    method: 'chat.startTurn',
    fingerprint_version: 1,
    fingerprint: 'normalized-intent',
    source_instance_id: 'instance-before-restart',
    decision: 'accepted',
    target_json: '{"runId":"run"}',
    result_json: '{"draftId":"draft-one","sourceRevision":"7","committedRevision":"8"}',
    error_code: null,
    decided_at: now,
    ...overrides,
  }
  database.prepare(`${insert} INTO command_receipts (${Object.keys(values).join(', ')}) VALUES (${Object.keys(values).map(() => '?').join(', ')})`).run(...Object.values(values))
}

describe('persistence schema migration', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  it('keeps runtime databases on v42 and creates only an explicit pending persistence candidate', () => {
    const runtime = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(runtime)
    expect(runtime.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(runtime.prepare('SELECT name FROM sqlite_master WHERE name = \'storage_profile\'').get()).toBeUndefined()
    const database = candidate()
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_MIGRATION_SCHEMA_VERSION })
    expect(database.prepare('SELECT * FROM storage_profile').get()).toEqual({
      id: 1,
      data_generation: expect.stringMatching(/^[0-9a-f]{32}$/),
      local_actor_id: 'desktop-local',
      min_writer_version: 1,
      authority: 'legacy_jsonl',
      migration_state: 'pending',
    })
    expect(database.prepare('SELECT id, kind, state FROM storage_actors').all()).toEqual([{ id: 'desktop-local', kind: 'desktop', state: 'active' }])
    expect(() => database.exec('UPDATE storage_profile SET authority = \'sqlite\'')).toThrow()
    expect(() => database.exec('UPDATE storage_profile SET migration_state = \'ready\'')).toThrow()
  })

  it('preserves every existing row without inventing receipts or verified event watermarks', () => {
    const { sourcePath, sourceHash, databasePath, before } = fixture()
    let database = candidate(databasePath)
    expect(snapshot(database, before.columns)).toEqual(before)
    expect(database.prepare('SELECT * FROM command_receipts').all()).toEqual([])
    expect(database.prepare('SELECT next_event_sequence FROM runs').get()).toEqual({ next_event_sequence: null })
    expect(database.prepare('SELECT sequence, format_version FROM run_events ORDER BY sequence').all()).toEqual([
      { sequence: 1, format_version: 1 },
      { sequence: 4, format_version: 1 },
      { sequence: 5, format_version: 1 },
    ])
    const profile = database.prepare('SELECT * FROM storage_profile').get()
    addReceipt(database)
    const receipt = database.prepare('SELECT * FROM command_receipts').get()
    database.close()
    database = candidate(databasePath)
    expect(database.prepare('SELECT * FROM storage_profile').get()).toEqual(profile)
    expect(database.prepare('SELECT * FROM command_receipts').get()).toEqual(receipt)
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(hash(sourcePath)).toBe(sourceHash)
  })

  it('scopes immutable receipts by generation and actor and retains them when an actor is revoked', () => {
    const database = candidate()
    database.prepare('INSERT INTO storage_actors VALUES (?, \'device\', \'active\', ?)').run('device-fixture', now)
    addReceipt(database)
    addReceipt(database, { actor_id: 'device-fixture' })
    addReceipt(database, { data_generation: 'previous-generation' })
    const original = database.prepare('SELECT * FROM command_receipts ORDER BY data_generation, actor_id').all()
    expect(() => addReceipt(database)).toThrow('ALREADY_DECIDED')
    expect(() => addReceipt(database, { method: 'chat.cancel' })).toThrow('ALREADY_DECIDED')
    expect(() => addReceipt(database, { target_json: '{"runId":"different"}' }, 'INSERT OR REPLACE')).toThrow('ALREADY_DECIDED')
    expect(() => database.exec('UPDATE command_receipts SET target_json = \'{"runId":"different"}\'')).toThrow('IMMUTABLE')
    expect(() => database.exec('DELETE FROM command_receipts')).toThrow('IMMUTABLE')
    database.exec('UPDATE storage_actors SET state = \'revoked\' WHERE id = \'device-fixture\'')
    expect(() => database.exec('DELETE FROM storage_actors WHERE id = \'device-fixture\'')).toThrow()
    expect(database.prepare('SELECT * FROM command_receipts ORDER BY data_generation, actor_id').all()).toEqual(original)
  })

  it('stores a monotonic integer watermark independently of retained events', () => {
    const { databasePath } = fixture()
    const database = candidate(databasePath)
    database.exec('UPDATE runs SET next_event_sequence = 8; DELETE FROM run_events')
    expect(database.prepare('SELECT next_event_sequence FROM runs').get()).toEqual({ next_event_sequence: 8 })
    for (const invalid of [7, null])
      expect(() => database.prepare('UPDATE runs SET next_event_sequence = ?').run(invalid)).toThrow()
    database.prepare('UPDATE runs SET next_event_sequence = ?').run(9223372036854775807n)
    expect(database.prepare('SELECT CAST(next_event_sequence AS TEXT) AS sequence FROM runs').get()).toEqual({ sequence: '9223372036854775807' })
    expect(() => database.exec('UPDATE runs SET next_event_sequence = next_event_sequence + 1')).toThrow()
  })

  it('rolls the entire schema and identity back on a late DDL conflict', () => {
    const table = 'product_query_revisions'
    const { databasePath, before } = fixture()
    const conflict = new DatabaseSync(databasePath)
    conflict.exec(`CREATE TABLE ${table} (preserve TEXT); INSERT INTO ${table} VALUES ('unrecognized data')`)
    conflict.close()
    expect(() => candidate(databasePath)).toThrow('already exists')
    const rejected = new DatabaseSync(databasePath)
    databases.push(rejected)
    expect(rejected.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(rejected.prepare('SELECT name FROM sqlite_master WHERE name IN (\'storage_profile\', \'storage_actors\')').all()).toEqual([])
    expect(rejected.prepare(`SELECT * FROM ${table}`).all()).toEqual([{ preserve: 'unrecognized data' }])
    expect(snapshot(rejected, before.columns)).toEqual(before)
  })

  it.skipIf(process.platform === 'win32').each(['partial', 'before-commit', 'after-commit'])('recovers a process killed at %s without claiming SQLite authority', (checkpoint) => {
    const { databasePath, sourcePath, sourceHash, before } = fixture()
    const sql = checkpoint === 'partial'
      ? BUDDY_V43_PERSISTENCE_SCHEMA_SQL.slice(0, BUDDY_V43_PERSISTENCE_SCHEMA_SQL.indexOf('ALTER TABLE runs'))
      : BUDDY_V43_PERSISTENCE_SCHEMA_SQL
    const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { readFileSync, writeSync } from 'node:fs';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      db.exec(readFileSync(0, 'utf8'));
      if (process.argv[2] !== 'partial') db.exec('PRAGMA user_version=${BUDDY_MIGRATION_SCHEMA_VERSION}');
      if (process.argv[2] === 'after-commit') db.exec('COMMIT');
      writeSync(1, JSON.stringify(db.prepare('SELECT data_generation FROM storage_profile').get()));
      process.kill(process.pid, 'SIGKILL');
    `, databasePath, checkpoint], { encoding: 'utf8', input: sql, timeout: 10000 })
    expect(interrupted.error, 'Migration test subprocess must start').toBeUndefined()
    expect(interrupted.signal, interrupted.stderr).toBe('SIGKILL')
    const raw = new DatabaseSync(databasePath)
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: checkpoint === 'after-commit' ? BUDDY_MIGRATION_SCHEMA_VERSION : BUDDY_SCHEMA_VERSION })
    if (checkpoint !== 'after-commit')
      expect(raw.prepare('SELECT name FROM sqlite_master WHERE name = \'storage_profile\'').get()).toBeUndefined()
    raw.close()
    const database = candidate(databasePath)
    expect(snapshot(database, before.columns)).toEqual(before)
    expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toEqual({ authority: 'legacy_jsonl', migration_state: 'pending' })
    if (checkpoint === 'after-commit')
      expect(database.prepare('SELECT data_generation FROM storage_profile').get()).toEqual(JSON.parse(interrupted.stdout))
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(hash(sourcePath)).toBe(sourceHash)
  })

  it.each(['runtime', 'newer-writer', 'missing-identity', 'missing-constraint', 'missing-owner-constraint'])('rejects %s before changing the candidate journal or repairing its identity', (reason) => {
    const { databasePath } = fixture()
    const database = candidate(databasePath)
    if (reason === 'newer-writer')
      database.exec('UPDATE storage_profile SET min_writer_version = 2')
    if (reason === 'missing-identity')
      database.exec('DELETE FROM storage_profile')
    if (reason === 'missing-constraint')
      database.exec('DROP TRIGGER command_receipts_no_update')
    if (reason === 'missing-owner-constraint')
      database.exec('DROP INDEX storage_actors_desktop')
    database.exec('PRAGMA journal_mode = DELETE')
    database.close()
    const beforeHash = hash(databasePath)
    expect(() => reason === 'runtime' ? openBuddyDatabase({ databasePath }) : candidate(databasePath)).toThrow(/schema version|writer version|storage identity|storage constraints/)
    expect(hash(databasePath)).toBe(beforeHash)
    const rejected = new DatabaseSync(databasePath)
    expect(rejected.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    rejected.close()
  })
})
