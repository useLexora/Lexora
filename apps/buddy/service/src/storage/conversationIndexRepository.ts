import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { ConversationListFilter } from '../../../shared/conversation/conversationApi'
import type { ConversationHistoryQuery, LocalConversationHistoryItem, LocalConversationHistoryPage } from '../../../shared/conversation/conversationHistoryApi'
import type { ConversationRecord, ConversationRow } from './conversationRecord'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { conversationHistoryEntriesSchema, conversationHistoryQuerySchema } from '../../../shared/conversation/conversationHistoryApi'
import { idSchema, timestampSchema } from '../../../shared/runtime/apiValidation'
import { BuddyServiceError, parse } from '../rpc/runtimeRequest'
import { CONVERSATION_CURRENT_MODEL_SELECTION_SQL, toConversationRecord } from './conversationRecord'
import { createTaskMarkRepository } from './taskMarkRepository'

export type ConversationActivity = 'idle' | 'running' | 'awaiting_approval'

export interface ConversationSummaryRecord extends ConversationRecord {
  activity: ConversationActivity
  automationOccurrence: {
    automationId: string
    occurrenceId: string
    scheduledFor: string
  } | null
}

export interface ConversationIndexRepository {
  listRecent: (limit?: number, filter?: ConversationListFilter) => ConversationSummaryRecord[]
  listHistory: (input: ConversationHistoryQuery) => LocalConversationHistoryPage
  getHistoryEntries: (ids: readonly string[]) => readonly LocalConversationHistoryItem[]
}

interface ConversationSummaryRow extends ConversationRow {
  activity: ConversationActivity
  automation_id: string | null
  automation_occurrence_id: string | null
  automation_scheduled_for: string | null
}

const CONVERSATION_ACTIVITY_SQL = `CASE
  WHEN EXISTS (
    SELECT 1 FROM runs INNER JOIN approvals ON approvals.run_id = runs.id
    WHERE runs.conversation_id = conversations.id AND approvals.status = 'pending'
  ) THEN 'awaiting_approval'
  WHEN EXISTS (
    SELECT 1 FROM runs
    WHERE runs.conversation_id = conversations.id AND runs.status IN ('queued', 'running')
  ) THEN 'running'
  ELSE 'idle'
END`

const SUMMARY_SELECT = `
  SELECT conversations.*, ${CONVERSATION_CURRENT_MODEL_SELECTION_SQL} AS actor_model_selection_json,
    automation_occurrences.id AS automation_occurrence_id,
    automation_occurrences.automation_id AS automation_id,
    automation_occurrences.scheduled_for AS automation_scheduled_for,
    ${CONVERSATION_ACTIVITY_SQL} AS activity
  FROM conversations
  LEFT JOIN automation_occurrences
    ON automation_occurrences.conversation_id = conversations.id
    AND automation_occurrences.deleted_at IS NULL
`

const ATTENTION_SQL = `(
  attention.mark_id IS NOT NULL OR COALESCE(attention.forced_unread, 0) = 1
  OR EXISTS (
    SELECT 1 FROM (
      SELECT runs.id FROM runs
      WHERE runs.conversation_id = conversations.id
        AND runs.execution_kind = 'root' AND runs.status IN ('completed', 'failed')
        AND runs.purpose <> 'conversation.compaction'
      ORDER BY runs.completed_at DESC, runs.rowid DESC LIMIT 1
    ) AS result WHERE result.id IS NOT attention.seen_run_id
  )
  OR ${CONVERSATION_ACTIVITY_SQL} <> 'idle'
)`

const historyCursorSchema = z.object({
  version: z.literal(1),
  identity: z.string().regex(/^[a-f\d]{64}$/),
  updatedAt: timestampSchema,
  createdAt: timestampSchema,
  id: idSchema,
}).strict()

type HistoryCursor = z.infer<typeof historyCursorSchema>

function queryIdentity(input: ConversationHistoryQuery): string {
  return createHash('sha256').update(JSON.stringify({
    kind: input.kind,
    spaceId: input.spaceId,
    query: input.query,
    excludeIds: [...new Set(input.excludeIds ?? [])].sort(),
  })).digest('hex')
}

function parseHistoryCursor(cursor: string, identity: string): HistoryCursor {
  try {
    const buffer = Buffer.from(cursor, 'base64url')
    const payload = historyCursorSchema.parse(JSON.parse(buffer.toString('utf8')))
    if (buffer.toString('base64url') !== cursor || payload.identity !== identity)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return payload
  }
  catch {
    throw new BuddyServiceError('VALIDATION_FAILED')
  }
}

export function createConversationIndexRepository(
  database: DatabaseSync,
): ConversationIndexRepository {
  const visiblePredicate = database.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'archived_at')
    ? 'conversations.deleted_at IS NULL AND conversations.archived_at IS NULL'
    : 'conversations.deleted_at IS NULL'
  const marks = createTaskMarkRepository(database)
  const listRecent = database.prepare(`
    ${SUMMARY_SELECT}
    WHERE ${visiblePredicate}
      AND (? = 0 OR conversations.space_id IS ?)
      AND instr(lower(COALESCE(conversations.title, '')), lower(?)) > 0
      AND (? IS NULL OR conversations.id != ?)
    ORDER BY conversations.updated_at DESC, conversations.created_at DESC
    LIMIT ?
  `)

  function withMarks(rows: readonly ConversationSummaryRow[]): LocalConversationHistoryItem[] {
    const states = new Map(marks.states(rows.map(row => row.id)).map(state => [state.conversationId, state]))
    return rows.flatMap((row) => {
      const markState = states.get(row.id)
      return markState ? [{ conversation: toConversationSummary(row), markState }] : []
    })
  }

  return {
    listHistory(input) {
      const query = parse(conversationHistoryQuerySchema, input)
      const identity = queryIdentity(query)
      const cursor = query.cursor ? parseHistoryCursor(query.cursor, identity) : null
      const conditions = [visiblePredicate]
      const parameters: SQLInputValue[] = []
      if (query.spaceId !== undefined) {
        conditions.push('conversations.space_id IS ?')
        parameters.push(query.spaceId)
      }
      if (query.kind === 'search') {
        conditions.push(`(instr(lower(COALESCE(conversations.title, '')), lower(?)) > 0 OR instr(lower(COALESCE(spaces.name, '')), lower(?)) > 0)`)
        parameters.push(query.query!, query.query!)
      }
      else {
        conditions.push(query.kind === 'attention' ? ATTENTION_SQL : `NOT ${ATTENTION_SQL}`)
      }
      if (query.excludeIds?.length) {
        const ids = [...new Set(query.excludeIds)]
        conditions.push(`conversations.id NOT IN (${ids.map(() => '?').join(', ')})`)
        parameters.push(...ids)
      }
      if (cursor) {
        conditions.push('(conversations.updated_at, conversations.created_at, conversations.id) < (?, ?, ?)')
        parameters.push(cursor.updatedAt, cursor.createdAt, cursor.id)
      }
      const limit = query.limit ?? 10
      const rows = database.prepare(`
        ${SUMMARY_SELECT}
        LEFT JOIN task_attention AS attention ON attention.conversation_id = conversations.id
        ${query.kind === 'search' ? 'LEFT JOIN spaces ON spaces.id = conversations.space_id AND spaces.revoked_at IS NULL' : ''}
        WHERE ${conditions.join(' AND ')}
        ORDER BY conversations.updated_at DESC, conversations.created_at DESC, conversations.id DESC
        LIMIT ?
      `).all(...parameters, limit + 1) as unknown as ConversationSummaryRow[]
      const visible = rows.slice(0, limit)
      const last = visible.at(-1)
      return {
        items: withMarks(visible),
        nextCursor: rows.length > limit && last
          ? Buffer.from(JSON.stringify({ version: 1, identity, id: last.id, updatedAt: last.updated_at, createdAt: last.created_at } satisfies HistoryCursor)).toString('base64url')
          : null,
      }
    },
    getHistoryEntries(ids) {
      const input = parse(conversationHistoryEntriesSchema, { ids })
      const unique = [...new Set(input.ids)]
      if (unique.length === 0)
        return []
      const rows = database.prepare(`
        ${SUMMARY_SELECT}
        WHERE ${visiblePredicate} AND conversations.id IN (${unique.map(() => '?').join(', ')})
      `).all(...unique) as unknown as ConversationSummaryRow[]
      const entries = new Map(withMarks(rows).map(entry => [entry.conversation.id, entry]))
      return unique.flatMap(id => entries.has(id) ? [entries.get(id)!] : [])
    },
    listRecent(limit = 100, filter: ConversationListFilter = {}) {
      return (listRecent.all(filter.spaceId === undefined ? 0 : 1, filter.spaceId ?? null, filter.query?.trim() ?? '', filter.excludeConversationId ?? null, filter.excludeConversationId ?? null, limit) as unknown as ConversationSummaryRow[])
        .map(toConversationSummary)
    },
  }
}

function toConversationSummary(row: ConversationSummaryRow): ConversationSummaryRecord {
  return {
    ...toConversationRecord(row),
    activity: row.activity,
    automationOccurrence: row.automation_occurrence_id
      && row.automation_id
      && row.automation_scheduled_for
      ? {
          automationId: row.automation_id,
          occurrenceId: row.automation_occurrence_id,
          scheduledFor: row.automation_scheduled_for,
        }
      : null,
  }
}
