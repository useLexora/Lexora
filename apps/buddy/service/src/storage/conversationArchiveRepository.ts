import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { conversationExecutionResourcesReleased } from './ExecutionResourceQueries'

export type ConversationArchiveDays = 0 | 3 | 7 | 30
export interface ConversationArchiveQuery {
  kind: 'archived' | 'removed' | 'deleting' | 'managed'
  spaceId?: string | null
  query?: string
  limit?: number
  cursor?: string
}
export interface ConversationArchiveItem {
  id: string
  title: string | null
  spaceId: string | null
  archivedAt: string | null
  deletedAt: string | null
  updatedAt: string
  metadataRevision: number
  deletionStatus: 'pending' | 'failed' | null
  errorCode: string | null
}
export type ConversationArchiveRepository = ReturnType<typeof createConversationArchiveRepository>

const dueConditions = `p.days > 0 AND c.archived_at IS NOT NULL AND c.deleted_at IS NULL
  AND julianday(c.archived_at) + p.days <= julianday(?)
  AND NOT EXISTS (SELECT 1 FROM conversation_deletion_jobs j WHERE j.conversation_id = c.id)
  AND ${conversationExecutionResourcesReleased}
  AND NOT EXISTS (SELECT 1 FROM chat_queue q WHERE q.conversation_id = c.id AND q.state = 'waiting')
  AND NOT EXISTS (SELECT 1 FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.conversation_id = c.id AND a.status = 'pending')`

export function createConversationArchiveRepository(database: DatabaseSync) {
  return {
    list(input: ConversationArchiveQuery): { items: ConversationArchiveItem[], nextCursor: string | null } {
      const limit = input.limit ?? 30
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !['archived', 'removed', 'deleting', 'managed'].includes(input.kind))
        throw new BuddyServiceError('VALIDATION_FAILED')
      const identity = JSON.stringify([input.kind, input.query?.trim() ?? '', ...(input.spaceId === undefined ? [] : [input.spaceId])])
      const parameters: SQLInputValue[] = [input.query?.trim() ?? '']
      const conditions = [
        input.kind === 'managed'
          ? `((c.archived_at IS NOT NULL AND c.deleted_at IS NULL AND j.conversation_id IS NULL)
              OR (j.origin = 'conversation' AND j.status IN ('pending', 'failed')))`
          : input.kind === 'deleting' ? 'j.conversation_id IS NOT NULL' : input.kind === 'removed' ? 'c.deleted_at IS NOT NULL AND c.archived_at IS NULL AND (j.conversation_id IS NULL OR j.origin = \'legacy_removed\')' : 'c.archived_at IS NOT NULL AND c.deleted_at IS NULL AND j.conversation_id IS NULL',
        'instr(lower(COALESCE(c.title, \'\')), lower(?)) > 0',
      ]
      if (input.spaceId !== undefined) {
        conditions.push('c.space_id IS ?')
        parameters.push(input.spaceId)
      }
      if (input.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
          if (cursor.identity !== identity || typeof cursor.id !== 'string' || typeof cursor.updatedAt !== 'string')
            throw new Error('cursor')
          conditions.push('(c.updated_at, c.id) < (?, ?)')
          parameters.push(cursor.updatedAt, cursor.id)
        }
        catch { throw new BuddyServiceError('VALIDATION_FAILED') }
      }
      const rows = database.prepare(`SELECT c.id, c.title, c.space_id AS spaceId, c.archived_at AS archivedAt,
        c.deleted_at AS deletedAt, c.updated_at AS updatedAt, c.metadata_revision AS metadataRevision,
        j.status AS deletionStatus, j.error_code AS errorCode
        FROM conversations c LEFT JOIN conversation_deletion_jobs j ON j.conversation_id = c.id
        WHERE ${conditions.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`).all(...parameters, limit + 1) as unknown as ConversationArchiveItem[]
      const items = rows.slice(0, limit)
      const last = items.at(-1)
      return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ identity, updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
    },
    archive(id: string, now: string): boolean {
      return !!database.prepare(`UPDATE conversations SET archived_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM conversation_deletion_jobs WHERE conversation_id = conversations.id)`)
        .run(now, now, id)
        .changes
    },
    restore(id: string, now: string): boolean {
      return !!database.prepare(`UPDATE conversations SET archived_at = NULL, deleted_at = NULL, updated_at = ?
        WHERE id = ? AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM conversation_deletion_jobs WHERE conversation_id = conversations.id)`)
        .run(now, id)
        .changes
    },
    getPolicy(): { days: ConversationArchiveDays } {
      return database.prepare('SELECT days FROM conversation_archive_policy WHERE id = 1').get() as unknown as { days: ConversationArchiveDays }
    },
    setPolicy(days: ConversationArchiveDays): void {
      if (![0, 3, 7, 30].includes(days))
        throw new BuddyServiceError('VALIDATION_FAILED')
      database.prepare('UPDATE conversation_archive_policy SET days = ? WHERE id = 1').run(days)
    },
    due(now: string): string[] {
      return database.prepare(`SELECT c.id FROM conversations c, conversation_archive_policy p
        WHERE ${dueConditions} ORDER BY c.archived_at, c.id LIMIT 100`).all(now).map(row => String(row.id))
    },
    isDue(id: string, now: string): boolean {
      return !!database.prepare(`SELECT 1 FROM conversations c, conversation_archive_policy p
        WHERE ${dueConditions} AND c.id = ?`).get(now, id)
    },
  }
}
