import type { DatabaseSync } from 'node:sqlite'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type {
  ActivateConversationBranchInput,
  ConversationHistoryRepository,
} from './conversationHistoryRepository'
import type { ConversationIndexRepository } from './conversationIndexRepository'
import type {
  ConversationModelSelection,
  ConversationRecord,
  ConversationRow,
} from './conversationRecord'
import type { ConversationTimelineRepository } from './conversationTimelineRepository'
import { createConversationHistoryStore } from './conversationHistoryRepository'
import { createConversationIndexRepository } from './conversationIndexRepository'
import { requireConversationRecord, toConversationRecord } from './conversationRecord'
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
  modelSelection: ConversationModelSelection
  updatedAt: string
}

export interface ConversationRepository
  extends ConversationHistoryRepository, ConversationIndexRepository, ConversationTimelineRepository {
  activateBranch: (input: ActivateConversationBranchInput) => ConversationRecord
  create: (input: CreateConversationInput) => ConversationRecord
  findById: (id: string) => ConversationRecord | null
  isDeleted: (id: string) => boolean
  markDeleted: (id: string, deletedAt: string) => boolean
  rename: (input: RenameConversationInput) => ConversationRecord
  getTitleState: (id: string) => ConversationTitleState | null
  renameGenerated: (input: RenameConversationInput & { expectedRevision: number, userInitiated?: boolean }) => ConversationRecord | null
  setPermissionSettings: (
    input: SetConversationPermissionSettingsInput,
  ) => ConversationRecord | null
  setModelSelection: (
    input: SetConversationModelSelectionInput,
  ) => ConversationRecord | null
}

export function createConversationRepository(database: DatabaseSync): ConversationRepository {
  const findConversation = database.prepare('SELECT * FROM conversations WHERE id = ?')
  const insertConversation = database.prepare(`
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at,
      approval_policy, execution_profile, origin, deleted_at, title_source, title_revision
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'manual', 1)
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
      AND NOT EXISTS (
        SELECT 1 FROM runs
        WHERE conversation_id = conversations.id AND status IN ('queued', 'running')
      )
      AND deleted_at IS NULL
  `)
  const setModelSelection = database.prepare(`
    UPDATE conversations
    SET model_selection_json = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
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
    setModelSelection(input) {
      if (Number(setModelSelection.run(
        JSON.stringify(input.modelSelection),
        input.updatedAt,
        input.id,
      ).changes) !== 1) {
        return null
      }
      return requireConversationRecord(
        findConversation.get(input.id),
        input.id,
      )
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
