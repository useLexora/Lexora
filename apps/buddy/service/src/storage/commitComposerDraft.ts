import type { DatabaseSync } from 'node:sqlite'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import { createBuddyUserContent } from '../../../shared/conversation/buddyUserContent'

export interface CommitComposerDraftInput {
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  conversationId: string
  draftId: string
  executionProfile: BuddyExecutionProfile
  expectedRevision: number
  expectedBranchId?: string
  expectedSourceMessageId?: string
  spaceId: string | null
  updatedAt: string
}

export interface ComposerDraftCommitReceipt {
  committedRevision: number
  draftId: string
  sourceRevision: number
}

export class ComposerDraftCommitConflictError extends Error {
  readonly code = 'DRAFT_CONFLICT'

  constructor() {
    super('Lexora Buddy Composer draft changed before the request was committed')
    this.name = 'ComposerDraftCommitConflictError'
  }
}

export function createComposerDraftCommitter(database: DatabaseSync) {
  const clearDraft = database.prepare(`
    UPDATE composer_drafts
    SET scope_kind = 'conversation_branch', space_id = NULL, source_message_id = NULL,
      conversation_id = ?, branch_id = ?, revision = revision + 1,
      content_json = ?, updated_at = ?
    WHERE id = ? AND revision = ?
      AND approval_policy = ? AND execution_profile = ?
      AND (
        (scope_kind = 'global' AND ? IS NULL)
        OR (scope_kind IN ('space', 'task') AND space_id IS ?)
        OR (
          scope_kind = 'conversation_branch'
          AND conversation_id = ? AND branch_id = ?
        )
        OR (
          scope_kind IN ('message_edit', 'message_followup')
          AND conversation_id = ? AND branch_id = ? AND source_message_id = ?
        )
      )
  `)

  return (input: CommitComposerDraftInput): ComposerDraftCommitReceipt => {
    if (Number(clearDraft.run(
      input.conversationId,
      input.branchId,
      JSON.stringify(createBuddyUserContent()),
      input.updatedAt,
      input.draftId,
      input.expectedRevision,
      input.approvalPolicy,
      input.executionProfile,
      input.spaceId,
      input.spaceId,
      input.conversationId,
      input.expectedBranchId ?? input.branchId,
      input.conversationId,
      input.expectedBranchId ?? input.branchId,
      input.expectedSourceMessageId ?? null,
    ).changes) !== 1) {
      throw new ComposerDraftCommitConflictError()
    }
    return {
      committedRevision: input.expectedRevision + 1,
      draftId: input.draftId,
      sourceRevision: input.expectedRevision,
    }
  }
}
