import type { DatabaseSync } from 'node:sqlite'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type {
  ActivateConversationBranchInput,
  ConversationHistoryRepository,
} from './conversationHistoryRepository'
import type { ConversationIndexRepository } from './conversationIndexRepository'
import type { ConversationMemberRecord, ConversationMemberRepository } from './conversationMemberRepository'
import type {
  ConversationModelSelection,
  ConversationRecord,
  ConversationRow,
} from './conversationRecord'
import type { ConversationTimelineRepository } from './conversationTimelineRepository'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { createConversationHistoryStore } from './conversationHistoryRepository'
import { createConversationIndexRepository } from './conversationIndexRepository'
import { createConversationMemberRepository } from './conversationMemberRepository'
import { CONVERSATION_CURRENT_MODEL_SELECTION_SQL, requireConversationRecord, toConversationRecord } from './conversationRecord'
import { createConversationTimelineRepository } from './conversationTimelineRepository'
import { withTransaction } from './database'

export interface CreateConversationInput {
  approvalPolicy: BuddyApprovalPolicy
  id: string
  branchId: string
  spaceId: string | null
  title: string | null
  createdAt: string
  executionProfile: BuddyExecutionProfile
  origin?: ConversationRecord['origin']
}

export interface RenameConversationInput {
  id: string
  title: string
}

export interface ConversationTitleState {
  title: string | null
  source: 'legacy' | 'manual' | 'fallback' | 'generated'
  revision: number
}

export interface SetConversationPermissionSettingsInput {
  approvalPolicy: BuddyApprovalPolicy
  executionProfile: BuddyExecutionProfile
  id: string
  updatedAt: string
}

export interface SetConversationModelSelectionInput {
  id: string
  actorId?: string
  modelSelection: ConversationModelSelection | null
  updatedAt: string
}

export interface ConversationRepository
  extends ConversationHistoryRepository, ConversationIndexRepository, ConversationTimelineRepository {
  activateBranch: (input: ActivateConversationBranchInput) => ConversationRecord
  create: (input: CreateConversationInput) => ConversationRecord
  findMember: (conversationId: string, actorId: string) => ConversationMemberRecord | null
  findById: (id: string) => ConversationRecord | null
  isDeleted: (id: string) => boolean
  markDeleted: (id: string, deletedAt: string) => boolean
  rename: (input: RenameConversationInput) => ConversationRecord
  getTitleState: (id: string) => ConversationTitleState | null
  renameGenerated: (input: RenameConversationInput & { expectedRevision: number, userInitiated?: boolean }) => ConversationRecord | null
  setPermissionSettings: (
    input: SetConversationPermissionSettingsInput,
  ) => ConversationRecord | null
  listMembers: ConversationMemberRepository['list']
  addMember: (input: { id: string, buddyId: string, updatedAt: string }) => void
  removeMember: (input: { id: string, buddyId: string, updatedAt: string }) => void
  setBuddy: (input: { id: string, buddyId: string, updatedAt: string }) => ConversationRecord | null
  setModelSelection: (
    input: SetConversationModelSelectionInput,
  ) => ConversationRecord | null
}

export function createConversationRepository(database: DatabaseSync): ConversationRepository {
  const findConversation = database.prepare(`SELECT conversations.*, ${CONVERSATION_CURRENT_MODEL_SELECTION_SQL} AS actor_model_selection_json FROM conversations WHERE id = ?`)
  const members = createConversationMemberRepository(database)
  const insertConversation = database.prepare(`
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at,
      approval_policy, execution_profile, origin, deleted_at, title_source, title_revision, buddy_id
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'manual', 1, (SELECT default_buddy_id FROM buddy_catalog WHERE id = 1))
  `)
  const renameConversation = database.prepare(`
    UPDATE conversations
    SET title = ?, title_source = 'manual', title_revision = title_revision + 1
    WHERE id = ? AND deleted_at IS NULL
  `)
  const findTitle = database.prepare(`SELECT title, CASE WHEN title_source = 'manual' AND title_revision = 0 THEN 'legacy' ELSE title_source END AS source, title_revision AS revision FROM conversations WHERE id = ? AND deleted_at IS NULL`)
  const renameGenerated = database.prepare(`
    UPDATE conversations SET title = ?, title_source = 'generated', title_revision = title_revision + 1
    WHERE id = ? AND title_revision = ? AND (title_source != 'manual' OR ? = 1) AND deleted_at IS NULL
  `)
  const setPermissionSettings = database.prepare(`
    UPDATE conversations
    SET approval_policy = ?, execution_profile = ?, updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
  const markDeleted = database.prepare(`
    UPDATE conversations
    SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `)
  const history = createConversationHistoryStore(database)
  const index = createConversationIndexRepository(database)
  const timeline = createConversationTimelineRepository(database, history.lineage)

  return {
    activateBranch(input) {
      return withTransaction(database, () => {
        history.activateBranch(input)
        return requireConversationRecord(
          findConversation.get(input.conversationId),
          input.conversationId,
        )
      })
    },
    create(input) {
      return withTransaction(database, () => {
        insertConversation.run(
          input.id,
          input.spaceId,
          input.title,
          input.createdAt,
          input.createdAt,
          input.approvalPolicy,
          input.executionProfile,
          input.origin ?? 'interactive',
        )
        const current = findConversation.get(input.id) as unknown as ConversationRow
        members.join({ conversationId: input.id, actorId: current.buddy_id, joinedAt: input.createdAt })
        history.insertRootBranch({
          branchId: input.branchId,
          conversationId: input.id,
          createdAt: input.createdAt,
        })
        return requireConversationRecord(
          findConversation.get(input.id),
          input.id,
        )
      })
    },
    createBranch: history.repository.createBranch,
    createMessage: history.repository.createMessage,
    findMember: members.find,
    listMembers: members.list,
    addMember(input) {
      withTransaction(database, () => {
        members.join({ conversationId: input.id, actorId: input.buddyId, joinedAt: input.updatedAt })
        database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(input.updatedAt, input.id)
      })
    },
    removeMember(input) {
      withTransaction(database, () => {
        members.remove({ conversationId: input.id, actorId: input.buddyId, removedAt: input.updatedAt })
        database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(input.updatedAt, input.id)
      })
    },
    findById(id) {
      const row = findConversation.get(id) as ConversationRow | undefined
      return row ? toConversationRecord(row) : null
    },
    findMessageById: history.repository.findMessageById,
    isDeleted(id) {
      const row = findConversation.get(id) as ConversationRow | undefined
      return row?.deleted_at !== null && row?.deleted_at !== undefined
    },
    listBranchMessages: history.repository.listBranchMessages,
    listBranches: history.repository.listBranches,
    listMessagePage: history.repository.listMessagePage,
    listMessages: history.repository.listMessages,
    listRecent: index.listRecent,
    listTimelinePage: timeline.listTimelinePage,
    markDeleted(id, deletedAt) {
      return Number(markDeleted.run(deletedAt, deletedAt, id).changes) === 1
    },
    rename(input) {
      if (Number(renameConversation.run(input.title, input.id).changes) !== 1)
        throw new ConversationRepositoryError('cannot be renamed')
      return requireConversationRecord(
        findConversation.get(input.id),
        input.id,
      )
    },
    getTitleState(id) {
      return findTitle.get(id) as unknown as ConversationTitleState | undefined ?? null
    },
    renameGenerated(input) {
      if (Number(renameGenerated.run(input.title, input.id, input.expectedRevision, input.userInitiated ? 1 : 0).changes) !== 1)
        return null
      return requireConversationRecord(findConversation.get(input.id), input.id)
    },
    setPermissionSettings(input) {
      return withTransaction(database, () => {
        const current = findConversation.get(input.id) as ConversationRow | undefined
        if (!current || current.deleted_at !== null)
          return null
        if (
          current.approval_policy === input.approvalPolicy
          && current.execution_profile === input.executionProfile
        ) {
          return toConversationRecord(current)
        }
        if (Number(setPermissionSettings.run(
          input.approvalPolicy,
          input.executionProfile,
          input.updatedAt,
          input.id,
        ).changes) !== 1) {
          return null
        }
        return requireConversationRecord(
          findConversation.get(input.id),
          input.id,
        )
      })
    },
    setBuddy(input) {
      return withTransaction(database, () => {
        const current = findConversation.get(input.id) as ConversationRow | undefined
        if (!current || current.deleted_at !== null)
          return null
        const actor = database.prepare('SELECT kind, enabled, deleted_at FROM buddies WHERE id = ?').get(input.buddyId)
        if (!actor)
          throw new BuddyServiceError('BUDDY_NOT_FOUND')
        if (actor.deleted_at)
          throw new BuddyServiceError('BUDDY_DELETED')
        if (actor.kind !== 'actor')
          throw new BuddyServiceError('BUDDY_NOT_ACTOR')
        if (!actor.enabled)
          throw new BuddyServiceError('BUDDY_DISABLED')
        if (members.find(input.id, input.buddyId) === null)
          throw new BuddyServiceError('BUDDY_NOT_MEMBER')
        if (current.buddy_id === input.buddyId)
          return toConversationRecord(current)
        if (!database.prepare('UPDATE conversations SET buddy_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(input.buddyId, input.updatedAt, input.id).changes)
          return null
        return requireConversationRecord(findConversation.get(input.id), input.id)
      })
    },
    setModelSelection(input) {
      const current = findConversation.get(input.id) as ConversationRow | undefined
      if (!current || current.deleted_at !== null)
        return null
      members.setModelSelection({
        conversationId: input.id,
        actorId: input.actorId ?? current.buddy_id,
        modelSelection: input.modelSelection,
        updatedAt: input.updatedAt,
      })
      return requireConversationRecord(findConversation.get(input.id), input.id)
    },
  }
}

class ConversationRepositoryError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor(reason: string) {
    super(`Lexora Buddy conversation ${reason}`)
    this.name = 'ConversationRepositoryError'
  }
}
