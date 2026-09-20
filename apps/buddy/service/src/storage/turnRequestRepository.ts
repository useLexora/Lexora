import type { DatabaseSync } from 'node:sqlite'
import type { BuddyServiceTier, BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { RunInputContextItem } from './runInputRepository'
import { isExecutionProfileWithin } from '../../../shared/permissions/executionProfile'
import { createComposerDraftCommitter } from './commitComposerDraft'
import { withTransaction } from './database'

export function resolveTurnExecutionProfile(input: { executionProfile: BuddyExecutionProfile, runExecutionProfile?: BuddyExecutionProfile }): BuddyExecutionProfile {
  const profile = input.runExecutionProfile ?? input.executionProfile
  if (!isExecutionProfileWithin(profile, input.executionProfile))
    throw new TurnRequestConflictError()
  return profile
}

export interface PrepareTurnRequestInput {
  queuedMessageId?: string
  followup?: { parentBranchId: string, sourceMessageId: string, sourceRunId: string }
  approvalPolicy: BuddyApprovalPolicy
  attachmentBindings: readonly TurnAttachmentBinding[]
  branchId: string
  conversationId: string
  createdAt: string
  draft: {
    draftId: string
    expectedRevision: number
  }
  executionProfile: BuddyExecutionProfile
  runExecutionProfile?: BuddyExecutionProfile
  model: string
  modelParameters?: { contextWindow: number, maxTokens: number }
  spaceId: string | null
  provider: string
  requestFingerprint: string
  requestId: string
  runInput: {
    attachmentIds: readonly string[]
    contextItems: readonly RunInputContextItem[]
    prompt: string
    reasoning: BuddyThinkingLevel | null
    serviceTier: BuddyServiceTier | null
  }
  runId: string
  title: string | null
  userMessageContent: unknown
  userMessageId: string
}

export interface TurnAttachmentBinding {
  nameSource?: 'file' | 'clipboard'
  mimeType?: string
  createdAt: string
  id: string
  messageId: string
  sourceAttachmentId: string
  sourceDraftId: string | null
  storedPath: string
}

export interface TurnRequestRecord {
  branchId: string
  conversationId: string
  created: boolean
  draftReceipt: {
    committedRevision: number
    draftId: string
    sourceRevision: number
  } | null
  requestFingerprint: string
  requestId: string
  runId: string
}

export interface RetryInterruptedTurnRequestInput {
  createdAt: string
  requestId: string
  runId: string
}

export interface RegenerateTurnRequestInput {
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  conversationId: string
  createdAt: string
  executionProfile: BuddyExecutionProfile
  runExecutionProfile?: BuddyExecutionProfile
  forkedFromMessageId: string
  parentBranchId: string
  requestFingerprint: string
  requestId: string
  runId: string
  sourceRunId: string
}

export interface EditTurnRequestInput extends PrepareTurnRequestInput {
  forkedFromMessageId: string | null
  parentBranchId: string
  sourceUserMessageId: string
}

interface TurnRequestRow {
  branch_id: string
  conversation_id: string
  created_at: string
  committed_draft_revision: number | null
  draft_id: string | null
  draft_revision: number | null
  request_fingerprint: string
  request_id: string
  run_id: string
}

interface ConversationBindingRow {
  approval_policy: BuddyApprovalPolicy
  active_branch_id: string | null
  deleted_at: string | null
  execution_profile: BuddyExecutionProfile
  space_id: string | null
  origin: 'automation' | 'interactive'
}

interface RetryRunRow {
  pi_session_file: string | null
  approval_policy: BuddyApprovalPolicy
  branch_id: string
  conversation_id: string
  error_code: string | null
  execution_profile: BuddyExecutionProfile
  model: string
  context_window: number | null
  max_tokens: number | null
  provider: string
  purpose: string
  status: string
  triggering_message_id: string
}

interface MessageBindingRow {
  conversation_id: string
  role: string
}

interface RunModelSelectionRow {
  model_selection_json: string
}

export interface TurnRequestRepository {
  edit: (input: EditTurnRequestInput) => TurnRequestRecord
  findByRequestId: (requestId: string) => TurnRequestRecord | null
  prepare: (input: PrepareTurnRequestInput) => TurnRequestRecord
  regenerate: (input: RegenerateTurnRequestInput) => TurnRequestRecord
  retryInterrupted: (input: RetryInterruptedTurnRequestInput) => TurnRequestRecord
}

export function createTurnRequestRepository(database: DatabaseSync): TurnRequestRepository {
  const insertTreeSource = database.prepare('INSERT INTO run_tree_sources (run_id, source_run_id, position) VALUES (?, ?, ?)')
  const findFollowupSource = database.prepare(`
    SELECT messages.id FROM messages INNER JOIN runs ON runs.id = messages.run_id
    WHERE messages.id = ? AND messages.conversation_id = ? AND messages.branch_id = ?
      AND messages.role = 'assistant' AND runs.id = ? AND runs.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.run_id = runs.id
        AND later.role = 'assistant' AND (later.created_at > messages.created_at
          OR (later.created_at = messages.created_at AND later.id > messages.id)))
  `)
  const findRequest = database.prepare('SELECT * FROM turn_requests WHERE request_id = ?')
  const findConversation = database.prepare(`
    SELECT space_id, active_branch_id, approval_policy, execution_profile, origin, deleted_at
    FROM conversations WHERE id = ?
  `)
  const insertConversation = database.prepare(`
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at,
      approval_policy, execution_profile, model_selection_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)
  `)
  const insertBranch = database.prepare(`
    INSERT INTO conversation_branches (
      id, conversation_id, parent_branch_id, forked_from_message_id, created_at
    ) VALUES (?, ?, NULL, NULL, ?)
  `)
  const insertForkBranch = database.prepare(`
    INSERT INTO conversation_branches (
      id, conversation_id, parent_branch_id, forked_from_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `)
  const activateBranch = database.prepare(`
    UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?
  `)
  const updateConversationModel = database.prepare(`
    UPDATE conversations SET model_selection_json = ?, updated_at = ? WHERE id = ?
  `)
  const bindDraftAttachment = database.prepare(`
    UPDATE attachments
    SET draft_id = NULL, message_id = ?, stored_path = ?
    WHERE id = ? AND draft_id = ? AND message_id IS NULL
  `)
  const cloneMessageAttachment = database.prepare(`
    INSERT INTO attachments (
      id, draft_id, message_id, stored_path, name, mime_type, size_bytes, created_at, name_source, source_path
    )
    SELECT ?, NULL, ?, ?, attachments.name, attachments.mime_type,
      attachments.size_bytes, ?, attachments.name_source, attachments.source_path
    FROM attachments
    INNER JOIN messages ON messages.id = attachments.message_id
    WHERE attachments.id = ? AND messages.conversation_id = ?
  `)
  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id, conversation_id, branch_id, run_id, role, content_json, created_at
    ) VALUES (?, ?, ?, NULL, 'user', ?, ?)
  `)
  const findPreviousSession = database.prepare(`
    SELECT pi_session_file FROM runs
    WHERE conversation_id = ? AND branch_id = ?
      AND status IN ('completed', 'failed', 'cancelled')
      AND pi_session_file IS NOT NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  const insertRun = database.prepare(`
    INSERT INTO runs (
      id, conversation_id, branch_id, triggering_message_id, provider, model,
      context_window, max_tokens, purpose, status, pi_session_file, error_code,
      started_at, completed_at, approval_policy, execution_profile
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'chat', 'queued', ?, NULL, ?, NULL, ?, ?)
  `)
  const insertRunInput = database.prepare(`
    INSERT INTO run_inputs (
      run_id, prompt, attachment_ids_json, context_items_json,
      reasoning, service_tier, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertRequest = database.prepare(`
    INSERT INTO turn_requests (
      request_id, request_fingerprint, conversation_id, branch_id, run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertDraftRequest = database.prepare(`
    INSERT INTO turn_requests (
      request_id, request_fingerprint, conversation_id, branch_id, run_id, created_at,
      draft_id, draft_revision, committed_draft_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const commitDraft = createComposerDraftCommitter(database)
  const findRun = database.prepare('SELECT * FROM runs WHERE id = ?')
  const findMessage = database.prepare(`
    SELECT conversation_id, role FROM messages WHERE id = ?
  `)
  const findIncompleteRun = database.prepare(`
    SELECT 1 FROM runs
    WHERE conversation_id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `)
  const findPreviousCompletedSession = database.prepare(`
    SELECT pi_session_file FROM runs
    WHERE conversation_id = ? AND branch_id = ?
      AND status = 'completed' AND pi_session_file IS NOT NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  const updateRequestRun = database.prepare(`
    UPDATE turn_requests SET run_id = ? WHERE request_id = ? AND run_id = ?
  `)
  const cloneRunInput = database.prepare(`
    INSERT INTO run_inputs (
      run_id, prompt, attachment_ids_json, context_items_json,
      reasoning, service_tier, created_at
    )
    SELECT ?, prompt, attachment_ids_json, context_items_json,
      reasoning, service_tier, ?
    FROM run_inputs WHERE run_id = ?
  `)
  const findRunModelSelection = database.prepare(`
    SELECT json_object(
      'providerId', runs.provider,
      'modelId', runs.model,
      'reasoning', run_inputs.reasoning,
      'serviceTier', run_inputs.service_tier
    ) AS model_selection_json
    FROM runs
    INNER JOIN run_inputs ON run_inputs.run_id = runs.id
    WHERE runs.id = ?
  `)

  const findByRequestId = (requestId: string): TurnRequestRecord | null => {
    const row = findRequest.get(requestId) as TurnRequestRow | undefined
    return row ? toRecord(row, false) : null
  }

  return {
    edit(input) {
      return withTransaction(database, () => {
        const existing = findRequest.get(input.requestId) as TurnRequestRow | undefined
        if (existing) {
          if (existing.request_fingerprint !== input.requestFingerprint)
            throw new TurnRequestConflictError()
          return toRecord(existing, false)
        }
        const conversation = findConversation.get(input.conversationId) as ConversationBindingRow | undefined
        const sourceMessage = findMessage.get(input.sourceUserMessageId) as MessageBindingRow | undefined
        const forkMessage = input.forkedFromMessageId
          ? findMessage.get(input.forkedFromMessageId) as MessageBindingRow | undefined
          : null
        if (
          !conversation
          || conversation.space_id !== input.spaceId
          || conversation.active_branch_id !== input.parentBranchId
          || conversation.approval_policy !== input.approvalPolicy
          || conversation.execution_profile !== input.executionProfile
          || conversation.deleted_at !== null
          || findIncompleteRun.get(input.conversationId)
          || !sourceMessage
          || sourceMessage.conversation_id !== input.conversationId
          || sourceMessage.role !== 'user'
          || (input.forkedFromMessageId && forkMessage?.conversation_id !== input.conversationId)
        ) {
          throw new TurnRequestConflictError()
        }
        insertForkBranch.run(
          input.branchId,
          input.conversationId,
          input.forkedFromMessageId ? input.parentBranchId : null,
          input.forkedFromMessageId,
          input.createdAt,
        )
        activateBranch.run(input.branchId, input.createdAt, input.conversationId)

        insertMessage.run(
          input.userMessageId,
          input.conversationId,
          input.branchId,
          JSON.stringify(input.userMessageContent),
          input.createdAt,
        )
        bindAttachments(
          input,
          bindDraftAttachment,
          cloneMessageAttachment,
        )
        insertRun.run(
          input.runId,
          input.conversationId,
          input.branchId,
          input.userMessageId,
          input.provider,
          input.model,
          input.modelParameters?.contextWindow ?? null,
          input.modelParameters?.maxTokens ?? null,
          null,
          input.createdAt,
          input.approvalPolicy,
          resolveTurnExecutionProfile(input),
        )
        insertRunInput.run(
          input.runId,
          input.runInput.prompt,
          JSON.stringify(input.runInput.attachmentIds),
          JSON.stringify(input.runInput.contextItems),
          input.runInput.reasoning,
          input.runInput.serviceTier,
          input.createdAt,
        )
        updateConversationModel.run(
          stringifyModelSelection(input),
          input.createdAt,
          input.conversationId,
        )
        const draftReceipt = commitDraft({
          approvalPolicy: input.approvalPolicy,
          branchId: input.branchId,
          conversationId: input.conversationId,
          draftId: input.draft.draftId,
          executionProfile: input.executionProfile,
          expectedBranchId: input.parentBranchId,
          expectedRevision: input.draft.expectedRevision,
          expectedSourceMessageId: input.sourceUserMessageId,
          spaceId: input.spaceId,
          updatedAt: input.createdAt,
        })
        insertDraftRequest.run(
          input.requestId,
          input.requestFingerprint,
          input.conversationId,
          input.branchId,
          input.runId,
          input.createdAt,
          input.draft.draftId,
          input.draft.expectedRevision,
          draftReceipt.committedRevision,
        )
        return {
          branchId: input.branchId,
          conversationId: input.conversationId,
          created: true,
          draftReceipt,
          requestFingerprint: input.requestFingerprint,
          requestId: input.requestId,
          runId: input.runId,
        }
      })
    },
    findByRequestId,
    prepare(input) {
      return withTransaction(database, () => {
        const existing = findRequest.get(input.requestId) as TurnRequestRow | undefined
        if (existing) {
          if (existing.request_fingerprint !== input.requestFingerprint)
            throw new TurnRequestConflictError()
          return toRecord(existing, false)
        }
        if (input.queuedMessageId) {
          const queued = database.prepare('SELECT id FROM chat_queue WHERE id = ? AND state IN (\'waiting\', \'paused\') AND conversation_id = ? AND branch_id = ?').get(input.queuedMessageId, input.conversationId, input.branchId)
          if (!queued)
            throw new TurnRequestConflictError()
        }
        if (!input.queuedMessageId && !input.followup && database.prepare('SELECT id FROM chat_queue WHERE conversation_id = ? AND branch_id = ? AND state IN (\'waiting\', \'paused\') LIMIT 1').get(input.conversationId, input.branchId))
          throw new TurnRequestConflictError()
        const conversation = findConversation.get(input.conversationId) as ConversationBindingRow | undefined
        if (conversation) {
          if (
            conversation.space_id !== input.spaceId
            || (!input.followup && conversation.active_branch_id !== input.branchId)
            || conversation.approval_policy !== input.approvalPolicy
            || conversation.execution_profile !== input.executionProfile
            || conversation.deleted_at !== null
            || findIncompleteRun.get(input.conversationId)
          ) {
            throw new TurnRequestConflictError()
          }
        }
        else {
          insertConversation.run(
            input.conversationId,
            input.spaceId,
            input.title,
            input.createdAt,
            input.createdAt,
            input.approvalPolicy,
            input.executionProfile,
          )
          insertBranch.run(input.branchId, input.conversationId, input.createdAt)
          activateBranch.run(input.branchId, input.createdAt, input.conversationId)
        }

        if (input.followup) {
          if (!conversation || !findFollowupSource.get(input.followup.sourceMessageId, input.conversationId, input.followup.parentBranchId, input.followup.sourceRunId)) {
            throw new TurnRequestConflictError()
          }
          insertForkBranch.run(input.branchId, input.conversationId, input.followup.parentBranchId, input.followup.sourceMessageId, input.createdAt)
          activateBranch.run(input.branchId, input.createdAt, input.conversationId)
        }
        const previous = findPreviousSession.get(
          input.conversationId,
          input.branchId,
        ) as { pi_session_file: string } | undefined
        insertMessage.run(
          input.userMessageId,
          input.conversationId,
          input.branchId,
          JSON.stringify(input.userMessageContent),
          input.createdAt,
        )
        bindAttachments(
          input,
          bindDraftAttachment,
          cloneMessageAttachment,
        )
        insertRun.run(
          input.runId,
          input.conversationId,
          input.branchId,
          input.userMessageId,
          input.provider,
          input.model,
          input.modelParameters?.contextWindow ?? null,
          input.modelParameters?.maxTokens ?? null,
          previous?.pi_session_file ?? null,
          input.createdAt,
          input.approvalPolicy,
          resolveTurnExecutionProfile(input),
        )
        insertRunInput.run(
          input.runId,
          input.runInput.prompt,
          JSON.stringify(input.runInput.attachmentIds),
          JSON.stringify(input.runInput.contextItems),
          input.runInput.reasoning,
          input.runInput.serviceTier,
          input.createdAt,
        )
        if (input.followup)
          insertTreeSource.run(input.runId, input.followup.sourceRunId, 'after')
        updateConversationModel.run(
          stringifyModelSelection(input),
          input.createdAt,
          input.conversationId,
        )
        const committedDraftRevision = input.draft.expectedRevision + 1
        insertDraftRequest.run(
          input.requestId,
          input.requestFingerprint,
          input.conversationId,
          input.branchId,
          input.runId,
          input.createdAt,
          input.draft.draftId,
          input.draft.expectedRevision,
          committedDraftRevision,
        )
        const draftReceipt = input.queuedMessageId
          ? {
              draftId: input.draft.draftId,
              sourceRevision: input.draft.expectedRevision,
              committedRevision: input.draft.expectedRevision + 1,
            }
          : commitDraft({
              approvalPolicy: input.approvalPolicy,
              branchId: input.branchId,
              conversationId: input.conversationId,
              draftId: input.draft.draftId,
              executionProfile: input.executionProfile,
              expectedRevision: input.draft.expectedRevision,
              expectedBranchId: input.followup?.parentBranchId,
              expectedSourceMessageId: input.followup?.sourceMessageId,
              spaceId: input.spaceId,
              updatedAt: input.createdAt,
            })
        if (input.queuedMessageId)
          database.prepare('UPDATE chat_queue SET state = \'sent\', run_id = ? WHERE id = ?').run(input.runId, input.queuedMessageId)
        return {
          branchId: input.branchId,
          conversationId: input.conversationId,
          created: true,
          draftReceipt,
          requestFingerprint: input.requestFingerprint,
          requestId: input.requestId,
          runId: input.runId,
        }
      })
    },
    regenerate(input) {
      return withTransaction(database, () => {
        const existing = findRequest.get(input.requestId) as TurnRequestRow | undefined
        if (existing) {
          if (existing.request_fingerprint !== input.requestFingerprint)
            throw new TurnRequestConflictError()
          return toRecord(existing, false)
        }
        const conversation = findConversation.get(input.conversationId) as ConversationBindingRow | undefined
        const sourceRun = findRun.get(input.sourceRunId) as RetryRunRow | undefined
        if (
          !conversation
          || sourceRun?.branch_id !== input.parentBranchId
          || conversation.approval_policy !== input.approvalPolicy
          || conversation.execution_profile !== input.executionProfile
          || conversation.deleted_at !== null
          || findIncompleteRun.get(input.conversationId)
          || !sourceRun
          || sourceRun.conversation_id !== input.conversationId
          || sourceRun.triggering_message_id !== input.forkedFromMessageId
          || !new Set(['completed', 'failed', 'cancelled']).has(sourceRun.status)
        ) {
          throw new TurnRequestConflictError()
        }

        insertForkBranch.run(
          input.branchId,
          input.conversationId,
          input.parentBranchId,
          input.forkedFromMessageId,
          input.createdAt,
        )
        activateBranch.run(input.branchId, input.createdAt, input.conversationId)
        insertRun.run(
          input.runId,
          input.conversationId,
          input.branchId,
          input.forkedFromMessageId,
          sourceRun.provider,
          sourceRun.model,
          sourceRun.context_window,
          sourceRun.max_tokens,
          null,
          input.createdAt,
          input.approvalPolicy,
          resolveTurnExecutionProfile(input),
        )
        if (Number(cloneRunInput.run(input.runId, input.createdAt, input.sourceRunId).changes) !== 1)
          throw new TurnRequestConflictError()
        insertTreeSource.run(input.runId, input.sourceRunId, 'before')
        const modelSelection = findRunModelSelection.get(input.runId) as
          | RunModelSelectionRow
          | undefined
        if (!modelSelection)
          throw new TurnRequestConflictError()
        updateConversationModel.run(
          modelSelection.model_selection_json,
          input.createdAt,
          input.conversationId,
        )
        insertRequest.run(
          input.requestId,
          input.requestFingerprint,
          input.conversationId,
          input.branchId,
          input.runId,
          input.createdAt,
        )
        return {
          branchId: input.branchId,
          conversationId: input.conversationId,
          created: true,
          draftReceipt: null,
          requestFingerprint: input.requestFingerprint,
          requestId: input.requestId,
          runId: input.runId,
        }
      })
    },
    retryInterrupted(input) {
      return withTransaction(database, () => {
        const request = findRequest.get(input.requestId) as TurnRequestRow | undefined
        if (!request)
          throw new TurnRequestConflictError()
        const run = findRun.get(request.run_id) as RetryRunRow | undefined
        if (!run)
          throw new TurnRequestConflictError()
        const conversation = findConversation.get(run.conversation_id) as ConversationBindingRow | undefined
        if (!conversation || conversation.deleted_at !== null)
          throw new TurnRequestConflictError()
        if (run.status !== 'failed' || run.error_code !== 'RUNTIME_RESTARTED')
          return toRecord(request, false)
        if (findIncompleteRun.get(run.conversation_id))
          throw new TurnRequestConflictError()

        const previous = findPreviousCompletedSession.get(
          run.conversation_id,
          run.branch_id,
        ) as { pi_session_file: string } | undefined
        insertRun.run(
          input.runId,
          run.conversation_id,
          run.branch_id,
          run.triggering_message_id,
          run.provider,
          run.model,
          run.context_window,
          run.max_tokens,
          previous?.pi_session_file ?? null,
          input.createdAt,
          run.approval_policy,
          run.execution_profile,
        )
        if (Number(cloneRunInput.run(input.runId, input.createdAt, request.run_id).changes) !== 1)
          throw new TurnRequestConflictError()
        insertTreeSource.run(input.runId, request.run_id, 'before')
        if (Number(updateRequestRun.run(input.runId, input.requestId, request.run_id).changes) !== 1)
          throw new TurnRequestConflictError()
        return {
          ...toRecord(request, true),
          runId: input.runId,
        }
      })
    },
  }
}

export class TurnRequestConflictError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor() {
    super('Lexora Buddy turn request conflicts with an existing request')
    this.name = 'TurnRequestConflictError'
  }
}

export class TurnRequestAttachmentError extends Error {
  readonly code = 'ATTACHMENT_NOT_FOUND'

  constructor() {
    super('Lexora Buddy turn request attachment is unavailable')
    this.name = 'TurnRequestAttachmentError'
  }
}

function toRecord(row: TurnRequestRow, created: boolean): TurnRequestRecord {
  return {
    branchId: row.branch_id,
    conversationId: row.conversation_id,
    created,
    draftReceipt: row.draft_id !== null
      && row.draft_revision !== null
      && row.committed_draft_revision !== null
      ? {
          committedRevision: row.committed_draft_revision,
          draftId: row.draft_id,
          sourceRevision: row.draft_revision,
        }
      : null,
    requestFingerprint: row.request_fingerprint,
    requestId: row.request_id,
    runId: row.run_id,
  }
}

function stringifyModelSelection(input: Omit<PrepareTurnRequestInput, 'draft'>): string {
  return JSON.stringify({
    providerId: input.provider,
    modelId: input.model,
    reasoning: input.runInput.reasoning,
    serviceTier: input.runInput.serviceTier,
  })
}

function bindAttachments(
  input: Omit<PrepareTurnRequestInput, 'draft'>,
  bindDraftAttachment: ReturnType<DatabaseSync['prepare']>,
  cloneMessageAttachment: ReturnType<DatabaseSync['prepare']>,
): void {
  assertTurnAttachmentBindings(input)
  for (const binding of input.attachmentBindings) {
    const changes = binding.sourceDraftId !== null
      ? binding.id === binding.sourceAttachmentId
        ? Number(bindDraftAttachment.run(
            binding.messageId,
            binding.storedPath,
            binding.sourceAttachmentId,
            binding.sourceDraftId,
          ).changes)
        : 0
      : Number(cloneMessageAttachment.run(
          binding.id,
          binding.messageId,
          binding.storedPath,
          binding.createdAt,
          binding.sourceAttachmentId,
          input.conversationId,
        ).changes)
    if (changes !== 1)
      throw new TurnRequestAttachmentError()
  }
}

export function assertTurnAttachmentBindings(input: Omit<PrepareTurnRequestInput, 'draft'>): void {
  if (
    input.attachmentBindings.length !== input.runInput.attachmentIds.length
    || input.attachmentBindings.some((binding, index) => (
      binding.id !== input.runInput.attachmentIds[index]
      || binding.messageId !== input.userMessageId
    ))
  ) {
    throw new TurnRequestAttachmentError()
  }
}
