import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent, ListBuddyRunEventsOptions } from './BuddyRunEvent'
import { buddyRunEventSchema } from './BuddyRunEvent'

interface RunEventRow {
  run_id: string
  sequence: number
  event_type: string
  payload_json: string
  created_at: string
}

export class RunEventQueries {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  list(runId: string, options: ListBuddyRunEventsOptions = {}): BuddyRunEvent[] {
    const limit = options.limit ?? 500
    const rows = options.afterSequence === undefined
      ? this.#database.prepare(`
          SELECT * FROM run_events
          WHERE run_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        `).all(runId, limit).toReversed()
      : this.#database.prepare(`
          SELECT * FROM run_events
          WHERE run_id = ? AND sequence > ?
          ORDER BY sequence
          LIMIT ?
        `).all(runId, options.afterSequence, limit)
    return (rows as unknown as RunEventRow[]).map(toRunEvent)
  }

  listForConversation(
    conversationId: string,
    options: Pick<ListBuddyRunEventsOptions, 'limit'> = {},
  ): BuddyRunEvent[] {
    const limit = options.limit ?? 1_000
    const rows = this.#database.prepare(`
      SELECT * FROM (
        SELECT
          events.run_id,
          events.sequence,
          events.event_type,
          events.payload_json,
          events.created_at
        FROM run_events AS events
        INNER JOIN runs ON runs.id = events.run_id
        WHERE runs.conversation_id = ?
        ORDER BY events.created_at DESC, events.run_id DESC, events.sequence DESC
        LIMIT ?
      )
      ORDER BY created_at, run_id, sequence
    `).all(conversationId, limit)
    return (rows as unknown as RunEventRow[]).map(toRunEvent)
  }

  listForRuns(runIds: readonly string[]): BuddyRunEvent[] {
    const ids = [...new Set(runIds)]
    if (ids.length === 0)
      return []
    const rows = this.#database.prepare(`
      SELECT * FROM run_events
      WHERE run_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY created_at, run_id, sequence
    `).all(...ids)
    return (rows as unknown as RunEventRow[]).map(toRunEvent)
  }

  listCompactableTerminalRunIds(): string[] {
    const rows = this.#database.prepare(`
      SELECT DISTINCT runs.id
      FROM runs
      INNER JOIN run_events ON run_events.run_id = runs.id
      WHERE runs.status IN ('completed', 'failed', 'cancelled')
        AND run_events.event_type IN ('message.delta', 'message.block.delta', 'tool.updated', 'run.progress')
      ORDER BY runs.started_at, runs.id
    `).all() as unknown as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  listRunIds(): string[] {
    const rows = this.#database.prepare(`
      SELECT id FROM runs ORDER BY started_at, id
    `).all() as unknown as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  findConversationId(runId: string): string | null {
    const row = this.#database.prepare(`
      SELECT conversation_id FROM runs WHERE id = ?
    `).get(runId) as { conversation_id: string } | undefined
    return row?.conversation_id ?? null
  }

  isTerminalRun(runId: string): boolean {
    const row = this.#database.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as {
      status: string
    } | undefined
    return row?.status === 'completed' || row?.status === 'failed' || row?.status === 'cancelled'
  }
}

function toRunEvent(row: RunEventRow): BuddyRunEvent {
  return buddyRunEventSchema.parse({
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json),
    runId: row.run_id,
    sequence: row.sequence,
    type: row.event_type,
  })
}
