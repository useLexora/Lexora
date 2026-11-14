import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './database'
import { ExecutionResourceQueries } from './ExecutionResourceQueries'

export interface ConversationDeletionCommit {
  conversationId: string
  deletedAt: string
  tombstoned: boolean
  revokedGrantIds: string[]
}

export type ConversationDeletionRepository = ReturnType<typeof createConversationDeletionRepository>

export function createConversationDeletionRepository(database: DatabaseSync) {
  return {
    recoverLegacy(conversationId: string, now: string): ConversationDeletionCommit | null {
      return withTransaction(database, () => {
        const conversation = database.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(conversationId)
        if (!conversation || database.prepare('SELECT 1 FROM conversation_deletion_jobs WHERE conversation_id = ?').get(conversationId))
          return null
        if (!conversation.deleted_at) {
          if (!database.prepare('SELECT 1 FROM automation_occurrences WHERE conversation_id = ? AND deleted_at IS NOT NULL').get(conversationId))
            return null
          database.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, conversationId)
        }
        const grants = database.prepare('SELECT id FROM conversation_directory_grants WHERE conversation_id = ? AND revoked_at IS NULL').all(conversationId)
        database.prepare('UPDATE conversation_directory_grants SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL').run(now, conversationId)
        return { conversationId, deletedAt: String(conversation.deleted_at ?? now), tombstoned: false, revokedGrantIds: grants.map(row => String(row.id)) }
      })
    },
    commitLegacyRemoved(conversationId: string, now: string): ConversationDeletionCommit | null {
      return withTransaction(database, () => {
        const conversation = database.prepare(`SELECT deleted_at FROM conversations WHERE id = ? AND deleted_at IS NOT NULL AND archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM conversation_deletion_jobs WHERE conversation_id = conversations.id AND origin <> 'legacy_removed')`).get(conversationId)
        if (!conversation || new ExecutionResourceQueries(database).conversation(conversationId) !== 'released') {
          return null
        }
        const grants = database.prepare('SELECT id FROM conversation_directory_grants WHERE conversation_id = ? AND revoked_at IS NULL').all(conversationId)
        database.prepare('UPDATE conversation_directory_grants SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL').run(now, conversationId)
        database.prepare(`INSERT OR IGNORE INTO conversation_deletion_jobs (conversation_id, status, origin, created_at, updated_at)
          VALUES (?, 'pending', 'legacy_removed', ?, ?)`).run(conversationId, now, now)
        return { conversationId, deletedAt: String(conversation.deleted_at), tombstoned: false, revokedGrantIds: grants.map(row => String(row.id)) }
      })
    },
    commit(conversationId: string, now: string): ConversationDeletionCommit | null {
      return withTransaction(database, () => {
        const conversation = database.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(conversationId) as { deleted_at: string | null } | undefined
        if (!conversation)
          return null
        const deletedAt = conversation.deleted_at ?? now
        const grants = database.prepare('SELECT id FROM conversation_directory_grants WHERE conversation_id = ? AND revoked_at IS NULL').all(conversationId) as { id: string }[]
        if (conversation.deleted_at === null)
          database.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(deletedAt, deletedAt, conversationId)
        database.prepare('UPDATE conversation_directory_grants SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL').run(deletedAt, conversationId)
        database.prepare(`INSERT OR IGNORE INTO conversation_deletion_jobs (conversation_id, status, created_at, updated_at)
          VALUES (?, 'pending', ?, ?)`).run(conversationId, now, now)
        return { conversationId, deletedAt, tombstoned: conversation.deleted_at === null, revokedGrantIds: grants.map(grant => grant.id) }
      })
    },
    has(conversationId: string): boolean {
      return !!database.prepare('SELECT 1 FROM conversation_deletion_jobs WHERE conversation_id = ?').get(conversationId)
    },
    failed(conversationId: string, errorCode: string, now: string): void {
      database.prepare(`UPDATE conversation_deletion_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE conversation_id = ?`).run(errorCode, now, conversationId)
    },
    retry(conversationId: string, now: string): void {
      database.prepare(`UPDATE conversation_deletion_jobs SET status = 'pending', error_code = NULL, updated_at = ? WHERE conversation_id = ?`).run(now, conversationId)
    },
    complete(conversationId: string): void {
      database.prepare('DELETE FROM conversation_deletion_jobs WHERE conversation_id = ? AND NOT EXISTS (SELECT 1 FROM conversations WHERE id = ?)').run(conversationId, conversationId)
    },
    pending(): string[] {
      return database.prepare(`SELECT conversation_id FROM conversation_deletion_jobs WHERE status = 'pending' ORDER BY created_at, conversation_id`).all().map(row => String(row.conversation_id))
    },
    legacyPending(): string[] {
      return (database.prepare(`SELECT c.id FROM conversations c WHERE c.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversation_deletion_jobs j WHERE j.conversation_id = c.id) AND (
        EXISTS (SELECT 1 FROM conversation_directory_grants g WHERE g.conversation_id = c.id AND g.revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('queued', 'running'))
      ) ORDER BY c.id`).all() as { id: string }[]).map(row => row.id)
    },
  }
}
