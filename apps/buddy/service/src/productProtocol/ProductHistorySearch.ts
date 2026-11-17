import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { MessageRole } from '../storage/conversationHistoryRepository'
import type { ProductReadViews } from './ProductReadViews'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'
import { ProductPageReader } from './ProductPageReader'

const documentBytes = 262_144

export class ProductHistorySearch {
  readonly #database: DatabaseSync
  readonly #pages: ProductPageReader
  readonly #views: ProductReadViews

  constructor(database: DatabaseSync, instance: string, views: ProductReadViews) {
    this.#database = database
    this.#pages = new ProductPageReader(database, instance)
    this.#views = views
  }

  search(input: Record<string, unknown>) {
    const query = String(input.query).toLowerCase()
    const conditions = ['deleted_at IS NULL', input.scope === 'archived' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL']
    const params: SQLInputValue[] = []
    if (input.spaceId !== undefined) {
      conditions.push('space_id IS ?')
      params.push(input.spaceId as string | null)
    }
    if (input.conversationId !== undefined) {
      conditions.push('conversation_id = ?')
      params.push(String(input.conversationId))
    }
    const table = `(SELECT c.rowid * 2 AS rowid, 'task:' || c.id AS id, c.id AS conversation_id, c.space_id, c.deleted_at, c.archived_at FROM conversations c WHERE c.active_branch_id IS NOT NULL
      UNION ALL SELECT m.rowid * 2 + 1 AS rowid, 'message:' || m.id AS id, c.id AS conversation_id, c.space_id, c.deleted_at, c.archived_at
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role IN ('user', 'assistant') AND (m.run_id IS NULL OR EXISTS (
        SELECT 1 FROM runs r WHERE r.id = m.run_id AND r.conversation_id = m.conversation_id AND r.branch_id = m.branch_id
          AND r.execution_kind IN ('root', 'actor_child') AND (r.execution_kind = 'root' OR m.role = 'assistant' OR EXISTS (SELECT 1 FROM conversation_publications p WHERE p.message_id = m.id)))))`
    let skippedOversized = 0
    const page = this.#pages.read(`conversations.search:${input.scope ?? 'active'}:${query}`, input, table, conditions.join(' AND '), params, (key) => {
      const task = key.startsWith('task:')
      const id = key.slice(task ? 5 : 8)
      const row = task
        ? this.#database.prepare('SELECT id AS conversationId, active_branch_id AS branchId, title, space_id AS spaceId FROM conversations WHERE id = ?').get(id)!
        : this.#database.prepare(`SELECT m.conversation_id AS conversationId, m.branch_id AS branchId, c.title, c.space_id AS spaceId, m.role, m.created_at AS createdAt,
          CASE WHEN length(CAST(m.content_json AS BLOB)) <= ? THEN m.content_json ELSE NULL END AS content
          FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`).get(documentBytes, id)!
      const identity = { conversationId: String(row.conversationId), branchId: String(row.branchId), title: row.title === null ? null : searchableText(String(row.title)), spaceId: row.spaceId as string | null }
      if (task)
        return identity.title?.toLowerCase().includes(query) ? { kind: 'task', ...identity } : null
      if (row.content === null) {
        skippedOversized++
        return null
      }
      const source = this.#views.messageText({ role: row.role as MessageRole, content: JSON.parse(String(row.content)) })
      if (source === null)
        return null
      const text = searchableText(source)
      const offset = text.toLowerCase().indexOf(query)
      if (offset < 0)
        return null
      const start = Math.max(0, offset - 40)
      const snippet = text.slice(start, start + 320).replace(/[\uD800-\uDBFF]$/, '')
      return { kind: 'message', ...identity, messageId: id, role: row.role, createdAt: row.createdAt, snippet }
    })
    return { ...page, partial: page.nextCursor !== null || skippedOversized > 0, skippedOversized }
  }
}

function searchableText(value: string): string {
  return redactSensitiveText(value)
    .replace(/(?:\b[A-Z]:[\\/]|\\\\|(?<![\w:/])\/(?!\/))[^\s<>"'`]+/gi, '[path]')
}
