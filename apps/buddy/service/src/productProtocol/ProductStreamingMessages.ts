import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { productMessageSchema } from '../../../shared/productProtocol/views'

export class ProductStreamingMessages {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  start(runId: string, messageId: string, createdAt: string): z.infer<typeof productMessageSchema> | null {
    const run = this.#database.prepare(`SELECT r.conversation_id, r.branch_id FROM runs r JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = ? AND r.execution_kind = 'root' AND r.status IN ('queued', 'running') AND c.deleted_at IS NULL`).get(runId)
    if (!run || this.#database.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId))
      return null
    return productMessageSchema.parse({ id: messageId, conversationId: run.conversation_id, branchId: run.branch_id, runId, role: 'assistant', createdAt, body: { kind: 'text', text: '', interrupted: false, truncated: false }, resources: [] })
  }

  page(conversationId: string, branchId: string, cursor: string | null) {
    if (cursor !== null && !/^(?:0|[1-9]\d{0,18})$/.test(cursor))
      throw new ProductProtocolError('CURSOR_EXPIRED')
    const rows = this.#database.prepare(`SELECT e.rowid AS position, e.run_id, e.sequence, e.created_at, json_extract(e.payload_json, '$.messageId') AS id
      FROM run_events e JOIN runs r ON r.id = e.run_id JOIN conversations c ON c.id = r.conversation_id
      WHERE r.conversation_id = ? AND r.branch_id = ? AND r.execution_kind = 'root' AND r.status IN ('queued', 'running') AND c.deleted_at IS NULL
        AND e.rowid > ? AND e.event_type = 'message.started' AND json_extract(e.payload_json, '$.role') = 'assistant'
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = json_extract(e.payload_json, '$.messageId'))
        AND NOT EXISTS (SELECT 1 FROM run_events t WHERE t.run_id = e.run_id AND t.event_type IN ('message.completed', 'message.interrupted') AND json_extract(t.payload_json, '$.messageId') = json_extract(e.payload_json, '$.messageId'))
      ORDER BY e.rowid LIMIT ?`).all(conversationId, branchId, BigInt(cursor ?? '0'), PRODUCT_LIMITS.pageItems + 1)
    const items: z.infer<typeof productMessageSchema>[] = []
    let position = cursor ?? '0'
    for (const row of rows.slice(0, PRODUCT_LIMITS.pageItems)) {
      const message = this.start(String(row.run_id), String(row.id), String(row.created_at))!
      let text = ''
      let truncated = false
      const deltas = this.#database.prepare(`SELECT json_extract(payload_json, '$.delta') AS delta FROM run_events
        WHERE run_id = ? AND sequence > ? AND event_type = 'message.delta' AND json_extract(payload_json, '$.messageId') = ? ORDER BY sequence`)
      for (const event of deltas.iterate(String(row.run_id), row.sequence!, String(row.id))) {
        if (typeof event.delta !== 'string')
          continue
        const available = 131_072 - text.length
        text += event.delta.slice(0, available)
        if (event.delta.length > available) {
          truncated = true
          if (/[\uD800-\uDBFF]$/.test(text))
            text = text.slice(0, -1)
          break
        }
      }
      message.body = { kind: 'text', text, interrupted: false, truncated }
      if (productByteLength(JSON.stringify([...items, message])) > PRODUCT_LIMITS.pageBytes - 4096)
        break
      items.push(message)
      position = String(row.position)
    }
    return { items, nextCursor: rows.some(row => BigInt(String(row.position)) > BigInt(position)) ? position : null }
  }
}
