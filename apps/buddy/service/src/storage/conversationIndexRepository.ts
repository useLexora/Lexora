import type { DatabaseSync } from 'node:sqlite'
import type { ConversationListFilter } from '../../../shared/conversation/conversationApi'
import type { ConversationRecord, ConversationRow } from './conversationRecord'
import { CONVERSATION_CURRENT_MODEL_SELECTION_SQL, toConversationRecord } from './conversationRecord'

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
}

interface ConversationSummaryRow extends ConversationRow {
  activity: ConversationActivity
  automation_id: string | null
  automation_occurrence_id: string | null
  automation_scheduled_for: string | null
}

export function createConversationIndexRepository(
  database: DatabaseSync,
): ConversationIndexRepository {
  const listRecent = database.prepare(`
    SELECT conversations.*, ${CONVERSATION_CURRENT_MODEL_SELECTION_SQL} AS actor_model_selection_json,
      automation_occurrences.id AS automation_occurrence_id,
      automation_occurrences.automation_id AS automation_id,
      automation_occurrences.scheduled_for AS automation_scheduled_for,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM runs
          INNER JOIN approvals ON approvals.run_id = runs.id
          WHERE runs.conversation_id = conversations.id
            AND approvals.status = 'pending'
        ) THEN 'awaiting_approval'
        WHEN EXISTS (
          SELECT 1
          FROM runs
          WHERE runs.conversation_id = conversations.id
            AND runs.status IN ('queued', 'running')
        ) THEN 'running'
        ELSE 'idle'
      END AS activity
    FROM conversations
    LEFT JOIN automation_occurrences
      ON automation_occurrences.conversation_id = conversations.id
      AND automation_occurrences.deleted_at IS NULL
    WHERE conversations.deleted_at IS NULL
      AND (? = 0 OR conversations.space_id IS ?)
      AND instr(lower(COALESCE(conversations.title, '')), lower(?)) > 0
      AND (? IS NULL OR conversations.id != ?)
    ORDER BY conversations.updated_at DESC, conversations.created_at DESC
    LIMIT ?
  `)

  return {
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
