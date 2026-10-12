import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent, ListBuddyRunEventsOptions } from './BuddyRunEvent'
import type { RunEventCheckpoint, RunEventRecoveryRun } from './RunEventRecovery'
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
        WHERE runs.conversation_id = ? AND runs.execution_kind IN ('root', 'maintenance')
        ORDER BY events.created_at DESC, events.run_id DESC, events.sequence DESC
        LIMIT ?
      )
      ORDER BY created_at, run_id, sequence
    `).all(conversationId, limit)
    return (rows as unknown as RunEventRow[]).map(toRunEvent)
  }

  listForRuns(runIds: readonly string[], options: { latestActivityOnly?: boolean } = {}): BuddyRunEvent[] {
    const ids = [...new Set(runIds)]
    if (ids.length === 0)
      return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = options.latestActivityOnly
      ? this.#database.prepare(`
          WITH requested(run_id) AS (VALUES ${ids.map(() => '(?)').join(', ')}), positions(run_id, sequence) AS (
            SELECT run_id, (SELECT MAX(sequence) FROM run_events WHERE run_events.run_id = requested.run_id) FROM requested
            UNION
            SELECT run_id, (SELECT MAX(sequence) FROM run_events WHERE run_events.run_id = requested.run_id AND event_type = 'run.progress') FROM requested
          )
          SELECT events.* FROM positions JOIN run_events events ON events.run_id = positions.run_id AND events.sequence = positions.sequence
          ORDER BY events.created_at, events.run_id, events.sequence
        `).all(...ids)
      : this.#database.prepare(`
          SELECT * FROM run_events
          WHERE run_id IN (${placeholders})
          ORDER BY created_at, run_id, sequence
        `).all(...ids)
    return (rows as unknown as RunEventRow[]).map(toRunEvent)
  }

  listToolCounts(runIds: readonly string[]): ReadonlyMap<string, number> {
    const ids = [...new Set(runIds)]
    if (!ids.length)
      return new Map()
    const rows = this.#database.prepare(`
      SELECT run_id AS runId, COUNT(*) AS count FROM run_events
      WHERE run_id IN (${ids.map(() => '?').join(', ')}) AND event_type = 'tool.started'
      GROUP BY run_id
    `).all(...ids) as { runId: string, count: number }[]
    return new Map(rows.map(row => [row.runId, row.count]))
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

  listRecoveryRuns(): RunEventRecoveryRun[] {
    const rows = this.#database.prepare(`
      SELECT runs.id AS runId, runs.conversation_id AS conversationId, runs.status,
        checkpoints.last_sequence AS lastSequence,
        checkpoints.projection_version AS projectionVersion,
        checkpoints.file_fingerprint AS fileFingerprint,
        COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = runs.id), 0) AS projectedLastSequence
      FROM runs LEFT JOIN run_event_checkpoints AS checkpoints ON checkpoints.run_id = runs.id
      ORDER BY CASE WHEN runs.status IN ('queued', 'running') THEN 0 ELSE 1 END, runs.started_at, runs.id
    `).all() as unknown as Array<{
      conversationId: string
      fileFingerprint: string | null
      lastSequence: number | null
      projectedLastSequence: number
      projectionVersion: number | null
      runId: string
      status: string
    }>
    return rows.map(row => ({
      conversationId: row.conversationId,
      runId: row.runId,
      status: row.status,
      projectedLastSequence: row.projectedLastSequence,
      checkpoint: row.lastSequence === null || row.projectionVersion === null || row.fileFingerprint === null
        ? null
        : { lastSequence: row.lastSequence, projectionVersion: row.projectionVersion, fileFingerprint: row.fileFingerprint },
    }))
  }

  hasCheckpoint(runId: string, checkpoint: RunEventCheckpoint): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM run_event_checkpoints
      WHERE run_id = ? AND file_fingerprint = ? AND projection_version = ? AND last_sequence = ?
    `).get(runId, checkpoint.fileFingerprint, checkpoint.projectionVersion, checkpoint.lastSequence) !== undefined
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
