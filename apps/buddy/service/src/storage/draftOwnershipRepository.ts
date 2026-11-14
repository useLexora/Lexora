import type { DatabaseSync } from 'node:sqlite'
import type { BuddyComposerDraftScope } from '../../../shared/conversation/composerDraft'
import { withTransaction } from './transaction'

export interface ComposerDraftSlot {
  ownerActorId: string
  scopeKey: string
  draftId: string | null
  slotRevision: number
}

export function composerDraftScopeKey(scope: BuddyComposerDraftScope): string {
  return JSON.stringify([
    scope.kind,
    scope.kind === 'space' ? scope.spaceId : null,
    'conversationId' in scope ? scope.conversationId : null,
    'branchId' in scope ? scope.branchId : null,
    scope.kind === 'message_edit' ? scope.userMessageId : scope.kind === 'message_followup' ? scope.assistantMessageId : null,
    scope.kind === 'task' ? scope.draftId : null,
  ])
}

export function createDraftOwnershipRepository(database: DatabaseSync, actorId: string) {
  const assertActor = () => {
    if (!database.prepare('SELECT 1 FROM storage_actors WHERE id = ? AND state = \'active\'').get(actorId))
      throw new Error('DRAFT_OWNER_UNAVAILABLE')
  }
  const findSlot = (scope: BuddyComposerDraftScope): ComposerDraftSlot | null => {
    assertActor()
    const scopeKey = composerDraftScopeKey(scope)
    const row = database.prepare('SELECT draft_id, slot_revision FROM composer_draft_slots WHERE owner_actor_id = ? AND scope_key = ?').get(actorId, scopeKey)
    return row ? { ownerActorId: actorId, scopeKey, draftId: row.draft_id as string | null, slotRevision: Number(row.slot_revision) } : null
  }
  return {
    actorId,
    assertActor,
    findSlot,
    owns(draftId: string): boolean {
      assertActor()
      return Boolean(database.prepare('SELECT 1 FROM composer_drafts WHERE id = ? AND owner_actor_id = ?').get(draftId, actorId))
    },
    select(scope: BuddyComposerDraftScope, draftId: string | null, expectedSlotRevision: number): ComposerDraftSlot {
      return withTransaction(database, () => {
        assertActor()
        if (!Number.isSafeInteger(expectedSlotRevision) || expectedSlotRevision < 0)
          throw new Error('DRAFT_SLOT_REVISION_CONFLICT')
        const scopeKey = composerDraftScopeKey(scope)
        if (draftId && !database.prepare(`SELECT 1 FROM composer_drafts WHERE id = ? AND owner_actor_id = ?
          AND json_array(scope_kind, CASE WHEN scope_kind = 'space' THEN space_id END,
            conversation_id, branch_id, source_message_id, CASE WHEN scope_kind = 'task' THEN id END) = ?`).get(draftId, actorId, scopeKey)) {
          throw new Error('DRAFT_OWNER_OR_SCOPE_MISMATCH')
        }
        const existing = findSlot(scope)
        if ((existing?.slotRevision ?? 0) !== expectedSlotRevision)
          throw new Error('DRAFT_SLOT_REVISION_CONFLICT')
        if (existing?.draftId === draftId)
          return existing
        if (expectedSlotRevision >= Number.MAX_SAFE_INTEGER)
          throw new Error('DRAFT_SLOT_REVISION_EXHAUSTED')
        if (!existing)
          database.prepare('INSERT INTO composer_draft_slots (owner_actor_id, scope_key, draft_id, slot_revision) VALUES (?, ?, ?, 1)').run(actorId, scopeKey, draftId)
        else
          database.prepare('UPDATE composer_draft_slots SET draft_id = ?, slot_revision = slot_revision + 1 WHERE owner_actor_id = ? AND scope_key = ? AND slot_revision = ?').run(draftId, actorId, scopeKey, expectedSlotRevision)
        return findSlot(scope)!
      })
    },
  }
}
