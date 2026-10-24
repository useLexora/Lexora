import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface ExecutionThreadRecord {
  id: string
  conversationId: string
  actorId: string
  kind: 'actor' | 'npc'
  createdAt: string
}

export interface ExecutionThreadBinding {
  threadId: string
  sessionFile: string
  rootEntryId: string
}

export function actorThreadId(conversationId: string, actorId: string): string {
  return `actor:${JSON.stringify([conversationId, actorId])}`
}

export function createThreadBindingRepository(database: DatabaseSync) {
  const previousSession = database.prepare(`
    SELECT pi_session_file FROM runs
    WHERE thread_id = ? AND branch_id = ?
      AND status IN ('completed', 'failed', 'cancelled')
      AND pi_session_file IS NOT NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  function find(id: string): ExecutionThreadRecord | null {
    return database.prepare('SELECT id, conversation_id AS conversationId, actor_id AS actorId, kind, created_at AS createdAt FROM execution_threads WHERE id = ?')
      .get(id) as unknown as ExecutionThreadRecord | undefined ?? null
  }

  return {
    find,
    findPreviousSession(threadId: string, branchId: string): string | null {
      const previous = previousSession.get(threadId, branchId) as { pi_session_file: string } | undefined
      return previous?.pi_session_file ?? null
    },
    ensureActor(conversationId: string, actorId: string, createdAt: string): ExecutionThreadRecord {
      if (!database.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND actor_id = ?').get(conversationId, actorId))
        throw new Error('Actor thread requires conversation membership')
      const id = actorThreadId(conversationId, actorId)
      database.prepare('INSERT OR IGNORE INTO execution_threads (id, conversation_id, actor_id, kind, created_at) VALUES (?, ?, ?, \'actor\', ?)')
        .run(id, conversationId, actorId, createdAt)
      return find(id)!
    },
    createNpc(conversationId: string, actorId: string, createdAt: string): ExecutionThreadRecord {
      const id = randomUUID()
      database.prepare('INSERT INTO execution_threads (id, conversation_id, actor_id, kind, created_at) VALUES (?, ?, ?, \'npc\', ?)')
        .run(id, conversationId, actorId, createdAt)
      return find(id)!
    },
    findBinding(threadId: string): ExecutionThreadBinding | null {
      return database.prepare('SELECT thread_id AS threadId, session_file AS sessionFile, root_entry_id AS rootEntryId FROM execution_thread_bindings WHERE thread_id = ?')
        .get(threadId) as unknown as ExecutionThreadBinding | undefined ?? null
    },
    bind(threadId: string, sessionFile: string, rootEntryId: string): void {
      database.prepare('INSERT INTO execution_thread_bindings (thread_id, session_file, root_entry_id) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET session_file = excluded.session_file, root_entry_id = excluded.root_entry_id')
        .run(threadId, sessionFile, rootEntryId)
    },
  }
}

export type ThreadBindingRepository = ReturnType<typeof createThreadBindingRepository>
