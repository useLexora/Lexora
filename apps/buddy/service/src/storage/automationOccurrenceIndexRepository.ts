import type { DatabaseSync } from 'node:sqlite'
import type {
  AutomationOccurrenceRecord,
  AutomationOccurrenceRow,
} from './automationOccurrenceRecord'
import type { AutomationCursor, AutomationPageRecord } from './automationPage'
import {
  requireAutomationOccurrenceRecord,
  toAutomationOccurrenceRecord,
} from './automationOccurrenceRecord'

export interface AutomationOccurrenceIndexRepository {
  findActiveOccurrence: (automationId: string) => AutomationOccurrenceRecord | null
  findOccurrenceByConversationId: (
    conversationId: string,
  ) => AutomationOccurrenceRecord | null
  findOccurrenceById: (id: string) => AutomationOccurrenceRecord | null
  findOccurrenceForDeletion: (id: string) => AutomationOccurrenceRecord | null
  findOccurrenceDeletionByConversation: (conversationId: string) => AutomationOccurrenceRecord | null
  listPendingDeletions: () => AutomationOccurrenceRecord[]
  listHistory: (input: {
    automationId?: string | null
    before?: AutomationCursor | null
    limit: number
  }) => AutomationPageRecord<AutomationOccurrenceRecord>
}

export interface AutomationOccurrenceIndexStore {
  hasActiveOccurrence: (automationId: string) => boolean
  repository: AutomationOccurrenceIndexRepository
  requireById: (id: string) => AutomationOccurrenceRecord
}

export function createAutomationOccurrenceIndexStore(
  database: DatabaseSync,
): AutomationOccurrenceIndexStore {
  const findOccurrence = database.prepare(`
    SELECT * FROM automation_occurrences WHERE id = ? AND deleted_at IS NULL
  `)
  const findOccurrenceByConversation = database.prepare(`
    SELECT * FROM automation_occurrences
    WHERE conversation_id = ? AND deleted_at IS NULL
  `)
  const findActiveOccurrence = database.prepare(`
    SELECT automation_occurrences.*
    FROM automation_occurrences
    LEFT JOIN runs ON runs.id = automation_occurrences.run_id
    WHERE automation_occurrences.automation_id = ?
      AND automation_occurrences.deleted_at IS NULL
      AND (
        (automation_occurrences.status = 'queued' AND automation_occurrences.run_id IS NULL)
        OR (
          automation_occurrences.status = 'bound'
          AND runs.status IN ('queued', 'running')
        )
      )
    ORDER BY automation_occurrences.queued_at, automation_occurrences.id
    LIMIT 1
  `)

  return {
    hasActiveOccurrence(automationId) {
      return findActiveOccurrence.get(automationId) !== undefined
    },
    repository: {
      findActiveOccurrence(automationId) {
        return toOptionalOccurrence(findActiveOccurrence.get(automationId))
      },
      findOccurrenceByConversationId(conversationId) {
        return toOptionalOccurrence(findOccurrenceByConversation.get(conversationId))
      },
      findOccurrenceById(id) {
        return toOptionalOccurrence(findOccurrence.get(id))
      },
      findOccurrenceForDeletion(id) {
        return toOptionalOccurrence(database.prepare('SELECT * FROM automation_occurrences WHERE id = ?').get(id))
      },
      findOccurrenceDeletionByConversation(conversationId) {
        return toOptionalOccurrence(database.prepare('SELECT * FROM automation_occurrences WHERE conversation_id = ?').get(conversationId))
      },
      listPendingDeletions() {
        return (database.prepare(`SELECT o.* FROM automation_occurrences o
          INNER JOIN conversations c ON c.id = o.conversation_id
          LEFT JOIN runs r ON r.id = o.run_id
          WHERE o.deleted_at IS NOT NULL AND (c.deleted_at IS NULL OR r.status IN ('queued', 'running'))
          ORDER BY o.deleted_at, o.id`).all() as unknown as AutomationOccurrenceRow[]).map(toAutomationOccurrenceRecord)
      },
      listHistory(input) {
        const clauses: string[] = [
          'automation_occurrences.deleted_at IS NULL',
          '(automation_occurrences.conversation_id IS NULL OR conversations.deleted_at IS NULL)',
        ]
        const parameters: Array<string | number> = []
        if (input.automationId) {
          clauses.push('automation_id = ?')
          parameters.push(input.automationId)
        }
        if (input.before) {
          clauses.push('(scheduled_for < ? OR (scheduled_for = ? AND id < ?))')
          parameters.push(
            input.before.occurredAt,
            input.before.occurredAt,
            input.before.id,
          )
        }
        const rows = database.prepare(`
          SELECT automation_occurrences.* FROM automation_occurrences
          LEFT JOIN conversations
            ON conversations.id = automation_occurrences.conversation_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY scheduled_for DESC, id DESC
          LIMIT ?
        `).all(...parameters, input.limit + 1) as unknown as AutomationOccurrenceRow[]
        const selected = rows.slice(0, input.limit)
        const last = selected.at(-1)
        return {
          items: selected.map(toAutomationOccurrenceRecord),
          nextCursor: rows.length > input.limit && last
            ? { id: last.id, occurredAt: last.scheduled_for }
            : null,
        }
      },
    },
    requireById(id) {
      return requireAutomationOccurrenceRecord(findOccurrence.get(id), id)
    },
  }
}

function toOptionalOccurrence(value: unknown): AutomationOccurrenceRecord | null {
  const row = value as AutomationOccurrenceRow | undefined
  return row ? toAutomationOccurrenceRecord(row) : null
}
