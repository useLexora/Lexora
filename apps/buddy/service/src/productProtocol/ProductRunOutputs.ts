import type { DatabaseSync } from 'node:sqlite'
import type { ProductPageReader } from './ProductPageReader'
import type { ProductReadViews } from './ProductReadViews'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { createConversationHistoryStore } from '../storage/conversationHistoryRepository'

export class ProductRunOutputs {
  readonly #database: DatabaseSync
  readonly #pages: ProductPageReader
  readonly #views: ProductReadViews

  constructor(database: DatabaseSync, pages: ProductPageReader, views: ProductReadViews) {
    this.#database = database
    this.#pages = pages
    this.#views = views
  }

  read(input: Record<string, unknown>) {
    const runId = String(input.runId)
    const branchId = String(input.branchId)
    const run = this.#database.prepare(`SELECT r.conversation_id, r.branch_id FROM runs r
      JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = ? AND c.deleted_at IS NULL AND r.execution_kind IN ('root', 'actor_child')`).get(runId)
    if (!run)
      return { items: [], nextCursor: null }
    const conversationId = String(run.conversation_id)
    if (!this.#database.prepare('SELECT 1 FROM conversation_branches WHERE conversation_id = ? AND id = ?').get(conversationId, branchId))
      throw new ProductProtocolError('OBJECT_DELETED')
    const segment = createConversationHistoryStore(this.#database).lineage.listVisibleSegments(conversationId, branchId).find(item => item.branchId === run.branch_id)
    if (!segment)
      return { items: [], nextCursor: null }
    const boundary = segment.throughMessage
      ? Number(this.#database.prepare('SELECT sequence FROM conversation_publications WHERE message_id = ?').get(segment.throughMessage.id)?.sequence ?? 0)
      : null
    const table = `(SELECT e.rowid * 512 + CAST(j.key AS INTEGER) + 1 AS rowid, a.id, p.run_id, p.sequence
      FROM conversation_publications p
      JOIN run_events e ON e.run_id = p.run_id AND e.sequence = p.source_sequence
      JOIN json_each(e.payload_json, '$.artifactIds') j
      JOIN artifacts a ON a.id = j.value AND a.conversation_id = p.conversation_id
      WHERE p.kind = 'output' AND e.event_type = 'output.produced')`
    return this.#pages.read(`runs.listOutputs:${branchId}`, input, table, 'run_id = ? AND (? IS NULL OR sequence <= ?)', [runId, boundary, boundary], id => this.#views.resource(`artifact:${id}`))
  }
}
