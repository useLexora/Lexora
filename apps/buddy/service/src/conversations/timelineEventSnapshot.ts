import type { DatabaseSync } from 'node:sqlite'
import type { LocalTimelineEventWindow } from '../../../shared/conversation/conversationApi'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'

export function readTimelineEventSnapshot(database: DatabaseSync, runIds: string[]) {
  const ids = JSON.stringify(runIds)
  const eventWindows = database.prepare(`
    SELECT run_id AS runId, MAX(sequence) AS throughSequence, COUNT(*) AS count
    FROM run_events WHERE run_id IN (SELECT value FROM json_each(?)) GROUP BY run_id
  `).all(ids) as unknown as LocalTimelineEventWindow[]
  const rows = database.prepare(`
    SELECT e.run_id AS runId, e.sequence, e.created_at AS createdAt, e.payload_json AS payload
    FROM run_events e JOIN runs r ON r.id = e.run_id
    WHERE e.run_id IN (SELECT value FROM json_each(?)) AND e.event_type = 'output.produced'
    ORDER BY r.started_at, e.run_id, e.sequence
  `).all(ids) as unknown as Array<Omit<BuddyRunEvent, 'type' | 'payload'> & { payload: string }>
  return { eventWindows, outputs: rows.map(row => ({ ...row, type: 'output.produced', payload: JSON.parse(row.payload) })) }
}
