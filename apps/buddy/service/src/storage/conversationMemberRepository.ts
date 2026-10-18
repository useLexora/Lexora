import type { DatabaseSync } from 'node:sqlite'
import type { ConversationModelSelection } from './conversationRecord'
import { buddyComposerDraftModelSelectionSchema } from '../../../shared/conversation/composerDraft'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { withTransaction } from './database'

export interface ConversationMemberRecord {
  conversationId: string
  actorId: string
  modelSelection: ConversationModelSelection | null
  modelSelectionSource: 'legacy' | 'explicit' | 'snapshot' | null
  joinedAt: string
}

export interface JoinConversationMemberInput {
  conversationId: string
  actorId: string
  joinedAt: string
}

export interface SetConversationMemberModelSelectionInput {
  conversationId: string
  actorId: string
  modelSelection: ConversationModelSelection | null
  updatedAt: string
  source?: 'legacy' | 'explicit'
}

export function createConversationMemberRepository(database: DatabaseSync) {
  const select = 'SELECT conversation_id AS conversationId, actor_id AS actorId, model_selection_json, model_selection_source AS modelSelectionSource, joined_at AS joinedAt FROM conversation_members'

  function find(conversationId: string, actorId: string): ConversationMemberRecord | null {
    const row = database.prepare(`${select} WHERE conversation_id = ? AND actor_id = ? AND removed_at IS NULL`).get(conversationId, actorId)
    return row ? toMember(row) : null
  }

  function requireConversation(conversationId: string) {
    const conversation = database.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(conversationId)
    if (!conversation || conversation.deleted_at !== null)
      throw new BuddyServiceError('VALIDATION_FAILED')
  }

  function requireActor(actorId: string) {
    const actor = database.prepare('SELECT kind, enabled, deleted_at FROM buddies WHERE id = ?').get(actorId)
    if (!actor)
      throw new BuddyServiceError('BUDDY_NOT_FOUND')
    if (actor.deleted_at !== null)
      throw new BuddyServiceError('BUDDY_DELETED')
    if (actor.kind !== 'actor')
      throw new BuddyServiceError('BUDDY_NOT_ACTOR')
    if (actor.enabled !== 1)
      throw new BuddyServiceError('BUDDY_DISABLED')
  }

  return {
    find,
    list(conversationId: string): ConversationMemberRecord[] {
      return database.prepare(`${select} WHERE conversation_id = ? AND removed_at IS NULL ORDER BY joined_at, actor_id`).all(conversationId).map(toMember)
    },
    join(input: JoinConversationMemberInput): ConversationMemberRecord {
      requireConversation(input.conversationId)
      requireActor(input.actorId)
      database.prepare('INSERT INTO conversation_members (conversation_id, actor_id, joined_at) VALUES (?, ?, ?) ON CONFLICT (conversation_id, actor_id) DO UPDATE SET removed_at = NULL')
        .run(input.conversationId, input.actorId, input.joinedAt)
      return find(input.conversationId, input.actorId)!
    },
    remove(input: { conversationId: string, actorId: string, removedAt: string }): void {
      requireConversation(input.conversationId)
      const current = database.prepare('SELECT buddy_id FROM conversations WHERE id = ?').get(input.conversationId)
      if (current?.buddy_id === input.actorId)
        throw new BuddyServiceError('BUDDY_LEADER_PROTECTED')
      database.prepare('UPDATE conversation_members SET removed_at = ? WHERE conversation_id = ? AND actor_id = ? AND removed_at IS NULL')
        .run(input.removedAt, input.conversationId, input.actorId)
    },
    setModelSelection(input: SetConversationMemberModelSelectionInput): ConversationMemberRecord {
      return withTransaction(database, () => {
        requireConversation(input.conversationId)
        requireActor(input.actorId)
        if (!find(input.conversationId, input.actorId))
          throw new BuddyServiceError('VALIDATION_FAILED')
        const selection = input.modelSelection === null ? null : buddyComposerDraftModelSelectionSchema.parse(input.modelSelection)
        database.prepare('UPDATE conversation_members SET model_selection_json = ?, model_selection_source = ? WHERE conversation_id = ? AND actor_id = ?')
          .run(selection === null ? null : JSON.stringify(selection), selection === null ? null : input.source ?? 'explicit', input.conversationId, input.actorId)
        database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(input.updatedAt, input.conversationId)
        return find(input.conversationId, input.actorId)!
      })
    },
  }
}

export type ConversationMemberRepository = ReturnType<typeof createConversationMemberRepository>

export function freezeConversationMemberModel(database: DatabaseSync, conversationId: string, actorId: string, selection: ConversationModelSelection): boolean {
  return Number(database.prepare(`UPDATE conversation_members SET model_selection_json = ?, model_selection_source = 'snapshot'
    WHERE conversation_id = ? AND actor_id = ? AND removed_at IS NULL AND model_selection_json IS NULL`)
    .run(JSON.stringify(selection), conversationId, actorId).changes) === 1
}

function toMember(row: Record<string, unknown>): ConversationMemberRecord {
  return {
    conversationId: row.conversationId as string,
    actorId: row.actorId as string,
    modelSelection: row.model_selection_json === null ? null : buddyComposerDraftModelSelectionSchema.parse(JSON.parse(row.model_selection_json as string)),
    modelSelectionSource: row.modelSelectionSource as ConversationMemberRecord['modelSelectionSource'],
    joinedAt: row.joinedAt as string,
  }
}
