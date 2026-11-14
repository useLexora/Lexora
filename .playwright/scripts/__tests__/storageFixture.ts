import type { DatabaseSync } from 'node:sqlite'

export const sqliteRunFixtureTime = '2026-09-29T00:00:00.000Z'

export function seedSqliteRun(database: DatabaseSync, runId: string, options: { conversationId?: string, nextSequence?: number | null } = {}) {
  const conversationId = options.conversationId ?? 'task-1'
  const branchId = `branch-${conversationId}`
  database.prepare('INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(conversationId, sqliteRunFixtureTime, sqliteRunFixtureTime)
  database.prepare('INSERT OR IGNORE INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(branchId, conversationId, sqliteRunFixtureTime)
  database.prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?').run(branchId, conversationId)
  database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)`).run(`input-${runId}`, conversationId, branchId, '{"text":"Fixture input"}', sqliteRunFixtureTime)
  database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, next_event_sequence)
    VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'queued', ?, ?)`).run(runId, conversationId, branchId, `input-${runId}`, sqliteRunFixtureTime, options.nextSequence === undefined ? 1 : options.nextSequence)
}
