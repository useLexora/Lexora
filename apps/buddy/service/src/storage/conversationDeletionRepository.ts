import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './database'

export interface ConversationDeletionCommit {
  conversationId: string
  deletedAt: string
  tombstoned: boolean
  revokedGrantIds: string[]
}

export type ConversationDeletionRepository = ReturnType<typeof createConversationDeletionRepository>

export function createConversationDeletionRepository(database: DatabaseSync) {
  return {
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
        return { conversationId, deletedAt, tombstoned: conversation.deleted_at === null, revokedGrantIds: grants.map(grant => grant.id) }
      })
    },
    pending(): string[] {
      return (database.prepare(`SELECT c.id FROM conversations c WHERE c.deleted_at IS NOT NULL AND (
        EXISTS (SELECT 1 FROM conversation_directory_grants g WHERE g.conversation_id = c.id AND g.revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('queued', 'running'))
      ) ORDER BY c.id`).all() as { id: string }[]).map(row => row.id)
    },
  }
}
