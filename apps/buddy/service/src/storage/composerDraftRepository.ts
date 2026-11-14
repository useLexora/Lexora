import type { DatabaseSync } from 'node:sqlite'
import type {
  BuddyComposerDraft,
  BuddyComposerDraftDiscard,
  BuddyComposerDraftOpen,
  BuddyComposerDraftSave,
  BuddyComposerDraftScope,
} from '../../../shared/conversation/composerDraft'
import { buddyComposerDraftSchema } from '../../../shared/conversation/composerDraft'
import { withTransaction } from './database'
import { createDraftOwnershipRepository } from './draftOwnershipRepository'

interface ComposerDraftRow {
  approval_policy: BuddyComposerDraft['executionConfig']['approvalPolicy']
  branch_id: string | null
  content_json: string
  conversation_id: string | null
  execution_profile: BuddyComposerDraft['executionConfig']['executionProfile']
  id: string
  model_selection_json: string | null
  participants_json: string | null
  revision: number
  scope_kind: BuddyComposerDraftScope['kind']
  source_message_id: string | null
  space_id: string | null
  updated_at: string
}

export interface ComposerDraftRepository {
  discard: (input: BuddyComposerDraftDiscard) => boolean
  list: () => BuddyComposerDraft[]
  findById: (draftId: string) => BuddyComposerDraft | null
  findByScope: (scope: BuddyComposerDraftScope) => BuddyComposerDraft | null
  open: (input: BuddyComposerDraftOpen & { now: string }) => BuddyComposerDraft
  save: (input: BuddyComposerDraftSave & { now: string }) => BuddyComposerDraft
}

export class ComposerDraftConflictError extends Error {
  readonly code = 'DRAFT_CONFLICT'

  constructor() {
    super('Lexora Buddy Composer draft revision conflicts with the persisted draft')
    this.name = 'ComposerDraftConflictError'
  }
}

export function createComposerDraftRepository(database: DatabaseSync, trustedActorId?: string): ComposerDraftRepository {
  const owned = Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'composer_draft_slots\'').get())
  const actorId = owned ? trustedActorId ?? String(database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()!.local_actor_id) : null
  const ownership = actorId ? createDraftOwnershipRepository(database, actorId) : null
  const findByIdStatement = database.prepare(`SELECT * FROM composer_drafts WHERE id = ?${ownership ? ' AND owner_actor_id = ?' : ''}`)
  const findGlobal = database.prepare('SELECT * FROM composer_drafts WHERE scope_kind = \'global\'')
  const findSpace = database.prepare('SELECT * FROM composer_drafts WHERE scope_kind = \'space\' AND space_id = ?')
  const findBranch = database.prepare(`
    SELECT * FROM composer_drafts
    WHERE scope_kind = 'conversation_branch' AND conversation_id = ? AND branch_id = ?
  `)
  const findMessageEdit = database.prepare(`
    SELECT * FROM composer_drafts
    WHERE scope_kind = ? AND conversation_id = ? AND branch_id = ?
      AND source_message_id = ?
  `)
  const insert = database.prepare(`
    INSERT INTO composer_drafts (
      id, scope_kind, space_id, conversation_id, branch_id, source_message_id, revision,
      content_json, model_selection_json, participants_json, approval_policy, execution_profile,
      created_at, updated_at${ownership ? ', owner_actor_id' : ''}
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?${ownership ? ', ?' : ''})
  `)
  const save = database.prepare(`
    UPDATE composer_drafts
    SET revision = revision + 1, content_json = ?, model_selection_json = ?, participants_json = ?,
      approval_policy = ?, execution_profile = ?, updated_at = ?,
      space_id = CASE WHEN scope_kind = 'task' THEN ? ELSE space_id END
    WHERE id = ? AND revision = ?
  `)

  const project = (row: ComposerDraftRow): BuddyComposerDraft => {
    const draft = toDraft(row)
    return ownership ? { ...draft, slotRevision: ownership.findSlot(draft.scope)?.slotRevision ?? 0 } : draft
  }

  const findById = (draftId: string): BuddyComposerDraft | null => {
    ownership?.assertActor()
    const row = (ownership ? findByIdStatement.get(draftId, actorId) : findByIdStatement.get(draftId)) as unknown as ComposerDraftRow | undefined
    return row ? project(row) : null
  }

  const findByScope = (scope: BuddyComposerDraftScope): BuddyComposerDraft | null => {
    if (ownership) {
      const slot = ownership.findSlot(scope)
      return slot?.draftId ? findById(slot.draftId) : null
    }
    if (scope.kind === 'task') {
      const draft = findById(scope.draftId)
      if (draft && draft.scope.kind !== 'task')
        throw new ComposerDraftConflictError()
      return draft
    }
    const row = scope.kind === 'global'
      ? findGlobal.get()
      : scope.kind === 'space'
        ? findSpace.get(scope.spaceId)
        : scope.kind === 'conversation_branch'
          ? findBranch.get(scope.conversationId, scope.branchId)
          : findMessageEdit.get(scope.kind, scope.conversationId, scope.branchId, scope.kind === 'message_edit' ? scope.userMessageId : scope.assistantMessageId)
    return row ? toDraft(row as unknown as ComposerDraftRow) : null
  }

  return {
    discard(input) {
      return withTransaction(database, () => {
        const draft = findById(input.draftId)
        if (!draft) {
          if (ownership && database.prepare('SELECT 1 FROM composer_drafts WHERE id = ?').get(input.draftId))
            throw new ComposerDraftConflictError()
          return true
        }
        if (draft.scope.kind !== 'task' || draft.revision !== input.expectedRevision)
          return false
        return Number(database.prepare(`
          DELETE FROM composer_drafts WHERE id = ? AND scope_kind = 'task' AND revision = ?
            AND NOT EXISTS (SELECT 1 FROM turn_requests WHERE draft_id = ?)
            AND NOT EXISTS (SELECT 1 FROM command_requests WHERE draft_id = ?)
        `).run(input.draftId, input.expectedRevision, input.draftId, input.draftId).changes) === 1
      })
    },
    list: () => {
      ownership?.assertActor()
      const query = database.prepare(`SELECT * FROM composer_drafts WHERE scope_kind IN ('task', 'global', 'space')${ownership ? ' AND owner_actor_id = ?' : ''} ORDER BY updated_at DESC`)
      return ((ownership ? query.all(actorId) : query.all()) as unknown as ComposerDraftRow[]).map(project)
    },
    findById,
    findByScope,
    open(input) {
      if (/^input-[a-f\d]{64}$/.test(input.draftId))
        throw new ComposerDraftConflictError()
      return withTransaction(database, () => {
        if (input.scope.kind === 'task' && input.scope.draftId !== input.draftId)
          throw new ComposerDraftConflictError()
        const scoped = findByScope(input.scope)
        if (scoped)
          return scoped
        if (findById(input.draftId))
          throw new ComposerDraftConflictError()
        const binding = toScopeBinding(input.scope)
        insert.run(
          input.draftId,
          input.scope.kind,
          binding.spaceId,
          binding.conversationId,
          binding.branchId,
          binding.sourceMessageId,
          JSON.stringify(input.initialContent),
          input.initialModelSelection ? JSON.stringify(input.initialModelSelection) : null,
          input.initialParticipants ? JSON.stringify(input.initialParticipants) : null,
          input.initialExecutionConfig.approvalPolicy,
          input.initialExecutionConfig.executionProfile,
          input.now,
          input.now,
          ...(ownership ? [actorId] : []),
        )
        if (ownership)
          ownership.select(input.scope, input.draftId, ownership.findSlot(input.scope)?.slotRevision ?? 0)
        return requireDraft(findById(input.draftId))
      })
    },
    save(input) {
      const draft = requireDraft(findById(input.draftId))
      if (input.spaceId !== undefined && draft.scope.kind !== 'task')
        throw new ComposerDraftConflictError()
      const spaceId = input.spaceId === undefined ? draft.scope.kind === 'task' ? draft.scope.spaceId : null : input.spaceId
      if (Number(save.run(
        JSON.stringify(input.content),
        input.modelSelection ? JSON.stringify(input.modelSelection) : null,
        input.participants ? JSON.stringify(input.participants) : null,
        input.executionConfig.approvalPolicy,
        input.executionConfig.executionProfile,
        input.now,
        spaceId,
        input.draftId,
        input.expectedRevision,
      ).changes) !== 1) {
        throw new ComposerDraftConflictError()
      }
      return requireDraft(findById(input.draftId))
    },
  }
}

function toDraft(row: ComposerDraftRow): BuddyComposerDraft {
  return buddyComposerDraftSchema.parse({
    content: JSON.parse(row.content_json),
    draftId: row.id,
    executionConfig: {
      approvalPolicy: row.approval_policy,
      executionProfile: row.execution_profile,
    },
    modelSelection: row.model_selection_json ? JSON.parse(row.model_selection_json) : null,
    ...(row.participants_json ? { participants: JSON.parse(row.participants_json) } : {}),
    revision: row.revision,
    scope: row.scope_kind === 'task'
      ? { kind: 'task', draftId: row.id, spaceId: row.space_id }
      : row.scope_kind === 'global'
        ? { kind: 'global' }
        : row.scope_kind === 'space'
          ? { kind: 'space', spaceId: requireValue(row.space_id) }
          : {
              branchId: requireValue(row.branch_id),
              conversationId: requireValue(row.conversation_id),
              ...(row.scope_kind === 'conversation_branch'
                ? { kind: 'conversation_branch' as const }
                : row.scope_kind === 'message_followup'
                  ? {
                      kind: 'message_followup' as const,
                      assistantMessageId: requireValue(row.source_message_id),
                    }
                  : {
                      kind: 'message_edit' as const,
                      userMessageId: requireValue(row.source_message_id),
                    }),
            },
    updatedAt: row.updated_at,
  })
}

function toScopeBinding(scope: BuddyComposerDraftScope) {
  switch (scope.kind) {
    case 'global': return { branchId: null, conversationId: null, sourceMessageId: null, spaceId: null }
    case 'task':
    case 'space': return { branchId: null, conversationId: null, sourceMessageId: null, spaceId: scope.spaceId }
    case 'conversation_branch': return {
      branchId: scope.branchId,
      conversationId: scope.conversationId,
      sourceMessageId: null,
      spaceId: null,
    }
    case 'message_edit': return {
      branchId: scope.branchId,
      conversationId: scope.conversationId,
      sourceMessageId: scope.userMessageId,
      spaceId: null,
    }
    case 'message_followup': return {
      branchId: scope.branchId,
      conversationId: scope.conversationId,
      sourceMessageId: scope.assistantMessageId,
      spaceId: null,
    }
  }
}

function requireDraft(draft: BuddyComposerDraft | null): BuddyComposerDraft {
  if (!draft)
    throw new ComposerDraftConflictError()
  return draft
}

function requireValue(value: string | null): string {
  if (value === null)
    throw new ComposerDraftConflictError()
  return value
}

export function findPersonalComposerDraft(database: DatabaseSync, draftId: string): BuddyComposerDraft | null {
  const owner = database.prepare('SELECT owner_actor_id FROM composer_drafts WHERE id = ?').get(draftId)
  return owner ? createComposerDraftRepository(database, String(owner.owner_actor_id)).findById(draftId) : null
}
