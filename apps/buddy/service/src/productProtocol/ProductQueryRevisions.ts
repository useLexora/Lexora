import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { encodeProductRevision, PRODUCT_INTEGER_MAX } from '../../../shared/productProtocol/scalars'
import { createConversationHistoryStore } from '../storage/conversationHistoryRepository'

export function productQueryRevision(database: DatabaseSync, method: string, input: Record<string, unknown>): string {
  const task = (id: unknown) => JSON.stringify(['task', String(id)])
  const branch = (conversationId: unknown, branchId: unknown) => JSON.stringify(['branch', String(conversationId), String(branchId)])
  const run = (id: unknown) => JSON.stringify(['run', String(id)])
  const dependencies: Array<[string, string]> = []
  const fingerprint = createHash('sha256')
  const add = (scope: string, ...tables: string[]) => dependencies.push(...tables.map(table => [table, scope] as [string, string]))
  const addVisibility = (conversationId: unknown) => add(task(conversationId), 'conversation_visibility')
  switch (method) {
    case 'spaces.list':
      add('', 'spaces')
      break
    case 'conversations.list':
      add('', 'conversations', 'approvals', 'run_summaries', 'automation_occurrences', 'user_questions', 'task_attention', 'publication_summaries', 'message_summaries')
      break
    case 'conversations.listMessages': {
      addVisibility(input.conversationId)
      const segments = createConversationHistoryStore(database).lineage.listVisibleSegments(String(input.conversationId), String(input.branchId))
      for (const segment of segments) {
        if (!segment.throughMessage) {
          add(branch(input.conversationId, segment.branchId), 'history_branches')
          continue
        }
        const boundary = segment.throughMessage
        const rows = database.prepare(`SELECT m.id, m.created_at, CAST(COALESCE(r.revision, 0) AS TEXT) AS revision
          FROM messages m LEFT JOIN product_query_revisions r ON r.table_name = 'history_messages' AND r.scope = json_array('message', m.id)
          WHERE m.conversation_id = ? AND m.branch_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.id <= ?))
            AND (m.run_id IS NULL OR EXISTS (SELECT 1 FROM conversation_publications WHERE message_id = m.id)
              OR EXISTS (SELECT 1 FROM runs WHERE id = m.run_id AND (execution_kind = 'root' OR (execution_kind = 'actor_child' AND m.role = 'assistant'))))
          ORDER BY m.created_at, m.id`).iterate(String(input.conversationId), segment.branchId, boundary.createdAt, boundary.createdAt, boundary.id)
        fingerprint.update(JSON.stringify([segment.branchId, boundary]))
        for (const row of rows) fingerprint.update(JSON.stringify(row))
      }
      const ancestors = database.prepare(`WITH RECURSIVE ancestors(id, parent_branch_id) AS (
        SELECT id, parent_branch_id FROM conversation_branches WHERE id = ? AND conversation_id = ?
        UNION SELECT b.id, b.parent_branch_id FROM conversation_branches b JOIN ancestors a ON b.id = a.parent_branch_id WHERE b.conversation_id = ?
      ) SELECT id FROM ancestors`).all(String(input.branchId), String(input.conversationId), String(input.conversationId))
      for (const ancestor of ancestors) add(branch(input.conversationId, ancestor.id), 'conversation_branches')
      break
    }
    case 'conversations.listBranches':
      addVisibility(input.conversationId)
      add(task(input.conversationId), 'conversation_branches', 'user_questions', 'approvals', 'run_summaries', 'chat_queue')
      break
    case 'questions.list':
    case 'runs.list':
    case 'chat.queue.list':
      addVisibility(input.conversationId)
      add(branch(input.conversationId, input.branchId), ...method === 'questions.list' ? ['user_questions', 'run_history'] : method === 'runs.list' ? ['runs', 'run_inputs'] : ['chat_queue', 'run_summaries'])
      break
    case 'runs.listEvents': {
      const owner = database.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(String(input.runId))
      if (owner)
        addVisibility(owner.conversation_id)
      add(run(input.runId), 'run_events', 'run_history')
      break
    }
    case 'approvals.list': {
      const owner = input.runId
        ? database.prepare('SELECT conversation_id, branch_id FROM runs WHERE id = ?').get(String(input.runId))
        : input.branchId ? database.prepare('SELECT conversation_id FROM conversation_branches WHERE id = ?').get(String(input.branchId)) : null
      const conversationId = input.conversationId ?? owner?.conversation_id
      if (conversationId)
        addVisibility(conversationId)
      else add('', 'conversation_visibility')
      const scope = input.runId ? run(input.runId) : input.branchId ? branch(conversationId, input.branchId) : conversationId ? task(conversationId) : ''
      add(scope, 'approvals', 'approval_reviews', 'approval_decisions', 'run_history')
      break
    }
    case 'resources.list':
      addVisibility(input.conversationId)
      add(task(input.conversationId), 'attachments', 'artifacts', 'messages', 'run_history', 'managed_files')
      break
    case 'taskMarks.list':
      add('', 'task_marks', 'task_attention', 'conversation_visibility')
      break
    case 'composerDrafts.list':
      add('', 'composer_drafts', 'composer_resources', 'attachments', 'managed_files', 'conversation_visibility')
      break
    default: throw new Error('PRODUCT_QUERY_REVISION_UNDEFINED')
  }
  const statement = database.prepare('SELECT revision FROM product_query_revisions WHERE table_name = ? AND scope = ?')
  statement.setReadBigInts(true)
  const unique = new Map(dependencies.map(value => [JSON.stringify(value), value]))
  for (const [, [table, scope]] of [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    fingerprint.update(JSON.stringify([table, scope, String(statement.get(table, scope)?.revision ?? 0)]))
  return encodeProductRevision(fingerprint.digest().readBigUInt64BE() & PRODUCT_INTEGER_MAX)
}
