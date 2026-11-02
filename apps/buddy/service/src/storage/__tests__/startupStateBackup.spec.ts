import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { mergeBackupDatabase, selectBackupDatabase } from '../backupDatabase'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'

const databases: DatabaseSync[] = []
const now = '2026-11-02T00:00:00.000Z'

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

function database() {
  const result = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(result)
  return result
}

function provider(database: DatabaseSync, id: string, enabled: number) {
  database.prepare('INSERT INTO provider_states (provider_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, enabled, now, now)
  database.prepare('INSERT INTO provider_resolution_checkpoints (provider_id, input_fingerprint) VALUES (?, ?)').run(id, `${id}-resolved`)
}

function task(database: DatabaseSync, id: string) {
  createConversationRepository(database).create({ id, branchId: `${id}-branch`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  database.prepare(`
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'fixture', 'model', 'chat', 'completed', ?, ?)
  `).run(`${id}-run`, id, `${id}-branch`, `${id}-input`, now, now)
  database.prepare('INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`${id}-message`, id, `${id}-branch`, `${id}-run`, 'assistant', JSON.stringify({ text: 'Preserved completed answer' }), now)
  database.prepare('UPDATE run_event_maintenance SET recovery_pending = 0, compaction_pending = 0, projection_version = 1, compaction_version = 1 WHERE run_id = ?').run(`${id}-run`)
}

it('restores provider configuration without trusting imported resolution checkpoints or invalidating unrelated providers', () => {
  const source = database()
  provider(source, 'restored', 0)
  selectBackupDatabase(source, ['providers'])
  expect(source.prepare('SELECT * FROM provider_resolution_checkpoints').all()).toEqual([])

  const target = database()
  provider(target, 'restored', 1)
  provider(target, 'unrelated', 1)
  mergeBackupDatabase(target, source, ['providers'])

  expect(target.prepare('SELECT provider_id, enabled FROM provider_states ORDER BY provider_id').all()).toEqual([
    { provider_id: 'restored', enabled: 0 },
    { provider_id: 'unrelated', enabled: 1 },
  ])
  expect(target.prepare('SELECT * FROM provider_resolution_checkpoints').all()).toEqual([
    { provider_id: 'unrelated', input_fingerprint: 'unrelated-resolved' },
  ])
  expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('marks restored history pending even without an existing checkpoint, preserving unrelated clean history', () => {
  const source = database()
  task(source, 'restored')
  const messages = source.prepare('SELECT * FROM messages ORDER BY id').all()
  selectBackupDatabase(source, ['tasks'])
  expect(source.prepare('SELECT * FROM run_event_maintenance').all()).toEqual([])

  const target = database()
  task(target, 'unrelated')
  mergeBackupDatabase(target, source, ['tasks'])
  expect(target.prepare('SELECT run_id, recovery_pending, compaction_pending FROM run_event_maintenance ORDER BY run_id').all()).toEqual([
    { run_id: 'restored-run', recovery_pending: 1, compaction_pending: 1 },
    { run_id: 'unrelated-run', recovery_pending: 0, compaction_pending: 0 },
  ])
  expect(target.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY id').all('restored-run')).toEqual(messages)
  expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(target.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
})
