import type { DatabaseSync } from 'node:sqlite'
import { sep } from 'node:path'
import { withTransaction } from './database'

export interface ConversationDirectoryGrantRecord {
  canonicalRoot: string
  conversationId: string
  createdAt: string
  id: string
  revokedAt: string | null
  root: string
}

export interface ConversationDirectoryGrantMutation {
  changed: boolean
  coveredGrantIds: readonly string[]
  grant: ConversationDirectoryGrantRecord
}

export interface ConversationDirectoryGrantRepository {
  grant: (input: {
    canonicalRoot: string
    conversationId: string
    createdAt: string
    id: string
    root: string
  }) => ConversationDirectoryGrantMutation
  listActive: (conversationId: string) => ConversationDirectoryGrantRecord[]
  revokeAll: (conversationId: string, revokedAt: string) => number
}

interface ConversationDirectoryGrantRow {
  canonical_root: string
  conversation_id: string
  created_at: string
  id: string
  revoked_at: string | null
  root: string
}

export function createConversationDirectoryGrantRepository(
  database: DatabaseSync,
): ConversationDirectoryGrantRepository {
  const list = database.prepare(`
    SELECT * FROM conversation_directory_grants
    WHERE conversation_id = ? AND revoked_at IS NULL
    ORDER BY created_at, id
  `)
  const insert = database.prepare(`
    INSERT INTO conversation_directory_grants (
      id, conversation_id, root, canonical_root, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?)
  `)
  const revoke = database.prepare(`
    UPDATE conversation_directory_grants
    SET revoked_at = ?
    WHERE conversation_id = ? AND id = ? AND revoked_at IS NULL
  `)
  const revokeAll = database.prepare(`
    UPDATE conversation_directory_grants
    SET revoked_at = ?
    WHERE conversation_id = ? AND revoked_at IS NULL
  `)

  const listActive = (conversationId: string): ConversationDirectoryGrantRecord[] => (
    (list.all(conversationId) as unknown as ConversationDirectoryGrantRow[]).map(toRecord)
  )

  return {
    grant(input) {
      return withTransaction(database, () => {
        if (!database.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL AND space_id IS NULL').get(input.conversationId))
          throw new ConversationDirectoryGrantOwnerError()
        const current = listActive(input.conversationId)
        const covering = [...current]
          .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)
          .find(grant => containsDirectory(grant.canonicalRoot, input.canonicalRoot))
        if (covering) {
          return {
            changed: false,
            coveredGrantIds: [],
            grant: covering,
          }
        }

        const covered = current.filter(grant => (
          containsDirectory(input.canonicalRoot, grant.canonicalRoot)
        ))
        if (current.length - covered.length + 1 > 32)
          impassableDirectoryGrant()
        for (const grant of covered)
          revoke.run(input.createdAt, input.conversationId, grant.id)
        insert.run(
          input.id,
          input.conversationId,
          input.root,
          input.canonicalRoot,
          input.createdAt,
        )
        const grant = listActive(input.conversationId).find(grant => grant.id === input.id)
        if (!grant)
          impassableDirectoryGrant()
        return {
          changed: true,
          coveredGrantIds: covered.map(grant => grant.id),
          grant,
        }
      })
    },
    listActive,
    revokeAll(conversationId, revokedAt) {
      return Number(revokeAll.run(revokedAt, conversationId).changes)
    },
  }
}

function toRecord(row: ConversationDirectoryGrantRow): ConversationDirectoryGrantRecord {
  return {
    canonicalRoot: row.canonical_root,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    id: row.id,
    revokedAt: row.revoked_at,
    root: row.root,
  }
}

function containsDirectory(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(prefix)
}

function impassableDirectoryGrant(): never {
  throw new Error('Lexora Buddy conversation directory grant could not be persisted')
}

class ConversationDirectoryGrantOwnerError extends Error {
  readonly code = 'DIRECTORY_GRANT_OWNER_INVALID'

  constructor() {
    super('Lexora Buddy directory grant owner is unavailable')
    this.name = 'ConversationDirectoryGrantOwnerError'
  }
}
