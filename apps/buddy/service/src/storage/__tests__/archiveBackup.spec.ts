import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { mergeBackupDatabase, selectBackupDatabase } from '../backupDatabase'
import { openBuddyDatabase } from '../database'

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
  const root = mkdtempSync(join(tmpdir(), 'lexora-archive-backup-'))
  roots.push(root)
  const databasePath = join(root, 'buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  return { database, databasePath }
}

function seed(database: DatabaseSync) {
  database.exec(`
    INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('task', 'Archived history', '${now}', '${now}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch', 'task', '${now}');
    INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
      VALUES ('input', 'task', 'branch', 'user', '{"text":"Keep history"}', '${now}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'completed', '${now}');
    UPDATE conversations SET archived_at = '${now}' WHERE id = 'task';
    UPDATE conversation_archive_policy SET days = 7;
    INSERT INTO conversation_deletion_jobs VALUES ('removed', 'failed', 'legacy_removed', 'RETRY_REQUIRED', '{"files":[]}', '${now}', '${now}');
  `)
}

it('keeps lineage in non-task snapshots without leaking archive policy or jobs', () => {
  const { database, databasePath } = fixture()
  seed(database)
  selectBackupDatabase(database, ['providers'])
  expect(database.prepare('SELECT * FROM conversation_archive_policy').all()).toEqual([])
  expect(database.prepare('SELECT * FROM conversation_deletion_jobs').all()).toEqual([])
  database.close()
  const reopened = openBuddyDatabase({ databasePath })
  databases.push(reopened)
  expect(reopened.prepare('SELECT lineage FROM buddy_schema_lineage').get()?.lineage).toBe('archive-v42')
  expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(42)
  expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('restores archived history, policy and durable jobs then restores active-admission protection', () => {
  const source = fixture()
  seed(source.database)
  selectBackupDatabase(source.database, ['tasks'])
  const target = fixture()
  mergeBackupDatabase(target.database, source.database, ['tasks'])
  expect(target.database.prepare('SELECT archived_at FROM conversations WHERE id = \'task\'').get()?.archived_at).toBe(now)
  expect(target.database.prepare('SELECT days FROM conversation_archive_policy').get()?.days).toBe(7)
  expect(target.database.prepare('SELECT conversation_id, origin, status FROM conversation_deletion_jobs').all()).toEqual([{ conversation_id: 'removed', origin: 'legacy_removed', status: 'failed' }])
  expect(target.database.prepare('SELECT status FROM runs WHERE id = \'run\'').get()?.status).toBe('completed')
  expect(() => target.database.exec('UPDATE runs SET status = \'queued\' WHERE id = \'run\'')).toThrow('CONVERSATION_NOT_ACTIVE')
  expect(target.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  target.database.close()
  const reopened = openBuddyDatabase({ databasePath: target.databasePath })
  databases.push(reopened)
  expect(reopened.prepare('SELECT count(*) AS count FROM conversation_deletion_jobs').get()?.count).toBe(1)
})
