import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent, ListBuddyRunEventsOptions } from './BuddyRunEvent'
import type { RunEventCheckpoint, RunEventRecoveryRun } from './RunEventRecovery'
import { buddyRunEventSchema } from './BuddyRunEvent'
import { RUN_EVENT_COMPACTION_VERSION, RUN_EVENT_PROJECTION_VERSION } from './RunEventRecovery'

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

  findLatest(runId: string, eventTypes: readonly string[]): BuddyRunEvent | null {
    if (!eventTypes.length)
      return null
    const row = this.#database.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? AND event_type IN (SELECT value FROM json_each(?))
      ORDER BY sequence DESC LIMIT 1
    `).get(runId, JSON.stringify(eventTypes)) as unknown as RunEventRow | undefined
    return row ? toRunEvent(row) : null
  }

  read(runId: string): BuddyRunEvent[] {
    const rows = this.#database.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence').all(runId) as unknown as RunEventRow[]
    return rows.map(toRunEvent)
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
    options: Pick<ListBuddyRunEventsOptions, 'limit'> & { excludedRunIds?: readonly string[] } = {},
  ): BuddyRunEvent[] {
    const limit = options.limit ?? 1_000
    const excluded = options.excludedRunIds ?? []
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
          ${excluded.length ? `AND runs.id NOT IN (${excluded.map(() => '?').join(', ')})` : ''}
        ORDER BY events.created_at DESC, events.run_id DESC, events.sequence DESC
        LIMIT ?
      )
      ORDER BY created_at, run_id, sequence
    `).all(conversationId, ...excluded, limit)
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

  listCompactableTerminalRunIds(after = '', limit = 16): string[] {
    const rows = this.#database.prepare(`
      WITH candidates AS (
        SELECT run_id FROM run_event_maintenance WHERE compaction_pending = 1 AND run_id > ?
        UNION
        SELECT run_id FROM run_event_maintenance WHERE compaction_version < ? AND run_id > ?
        UNION
        SELECT run_id FROM run_event_maintenance WHERE compaction_version > ? AND run_id > ?
      )
      SELECT runs.id FROM candidates JOIN runs ON runs.id = candidates.run_id
      WHERE runs.status IN ('completed', 'failed', 'cancelled')
      ORDER BY runs.id LIMIT ?
    `).all(after, RUN_EVENT_COMPACTION_VERSION, after, RUN_EVENT_COMPACTION_VERSION, after, limit) as unknown as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  findRecoveryRun(runId: string): RunEventRecoveryRun | null {
    return this.listRecoveryRuns({ runId })[0] ?? null
  }

  listRecoveryRuns(options: { force?: boolean, runId?: string } = {}): RunEventRecoveryRun[] {
    const rows = this.#database.prepare(`
      SELECT runs.id AS runId, runs.conversation_id AS conversationId, runs.status,
        checkpoints.last_sequence AS lastSequence,
        checkpoints.projection_version AS projectionVersion,
        checkpoints.file_fingerprint AS fileFingerprint,
        CASE WHEN maintenance.recovery_pending = 1 AND maintenance.compaction_pending = 1
          AND maintenance.projection_version = 0 AND maintenance.compaction_version = 0
          AND maintenance.revision = 0 THEN 1 ELSE 0 END AS bootstrapPending,
        COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = runs.id), 0) AS projectedLastSequence
      FROM runs LEFT JOIN run_event_checkpoints AS checkpoints ON checkpoints.run_id = runs.id
      LEFT JOIN run_event_maintenance AS maintenance ON maintenance.run_id = runs.id
      ${options.runId !== undefined
        ? 'WHERE runs.id = ?'
        : options.force
          ? ''
          : `WHERE runs.id IN (
            SELECT run_id FROM run_event_maintenance WHERE recovery_pending = 1
            UNION SELECT run_id FROM run_event_maintenance WHERE projection_version < ${RUN_EVENT_PROJECTION_VERSION}
            UNION SELECT run_id FROM run_event_maintenance WHERE projection_version > ${RUN_EVENT_PROJECTION_VERSION}
            UNION SELECT id FROM runs WHERE status IN ('queued', 'running')
          )`}
      ORDER BY CASE WHEN runs.status IN ('queued', 'running') THEN 0 ELSE 1 END, runs.started_at, runs.id
    `).all(...(options.runId !== undefined ? [options.runId] : [])) as unknown as Array<{
      bootstrapPending: number
      conversationId: string
      fileFingerprint: string | null
      lastSequence: number | null
      projectedLastSequence: number
      projectionVersion: number | null
      runId: string
      status: string
    }>
    return rows.map(row => ({
      bootstrapPending: row.bootstrapPending === 1,
      conversationId: row.conversationId,
      runId: row.runId,
      status: row.status,
      projectedLastSequence: row.projectedLastSequence,
      checkpoint: row.lastSequence === null || row.projectionVersion === null || row.fileFingerprint === null
        ? null
        : { lastSequence: row.lastSequence, projectionVersion: row.projectionVersion, fileFingerprint: row.fileFingerprint },
    }))
  }

  maintenanceRevision(runId: string): number {
    const row = this.#database.prepare('SELECT revision FROM run_event_maintenance WHERE run_id = ?').get(runId) as { revision: number } | undefined
    if (!row)
      throw new Error('Run event maintenance state is missing')
    return row.revision
  }

  hasCheckpoint(runId: string, checkpoint: RunEventCheckpoint): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM run_event_checkpoints
      WHERE EXISTS (SELECT 1 FROM run_event_maintenance WHERE run_id = run_event_checkpoints.run_id AND recovery_pending = 0)
        AND run_id = ? AND file_fingerprint = ? AND projection_version = ? AND last_sequence = ?
    `).get(runId, checkpoint.fileFingerprint, checkpoint.projectionVersion, checkpoint.lastSequence) !== undefined
  }

  listRunIds(conversationId?: string): string[] {
    const rows = this.#database.prepare(`
      SELECT id FROM runs ${conversationId === undefined ? '' : 'WHERE conversation_id = ?'} ORDER BY started_at, id
    `).all(...(conversationId === undefined ? [] : [conversationId])) as unknown as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  hasProjectedEvents(runId: string): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM run_events WHERE run_id = ?
      UNION ALL SELECT 1 FROM messages WHERE run_id = ? AND role IN ('assistant', 'tool')
      UNION ALL SELECT 1 FROM approvals WHERE run_id = ?
      UNION ALL SELECT 1 FROM usage_records WHERE run_id = ?
      UNION ALL SELECT 1 FROM execution_mailbox_sources WHERE source_run_id = ?
      UNION ALL SELECT 1 FROM execution_mailbox_receipts WHERE target_run_id = ?
      LIMIT 1
    `).get(runId, runId, runId, runId, runId, runId) !== undefined
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
