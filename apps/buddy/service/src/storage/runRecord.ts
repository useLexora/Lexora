import type { SpaceExecutionContext } from '../../../shared/conversation/space'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { BuddyExecutionDefinition } from '../buddies/BuddyExecutionDefinition'
import type { ConversationModelSelection } from './conversationRecord'
import { buddyComposerDraftModelSelectionSchema } from '../../../shared/conversation/composerDraft'
import { spaceExecutionContextSchema } from '../../../shared/conversation/space'
import { buddyExecutionDefinitionSchema } from '../buddies/BuddyExecutionDefinition'

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type RunPurpose = 'automation' | 'chat' | 'conversation.compaction'

export type ExecutionKind = 'root' | 'actor_child' | 'npc_child' | 'maintenance'

export interface RunRecord {
  rootRunId: string
  parentRunId: string | null
  executionKind: ExecutionKind
  threadId: string
  generation: number
  modelOverride?: ConversationModelSelection | null
  actorSnapshot?: BuddyExecutionDefinition | null
  buddyId: string
  approvalPolicy: BuddyApprovalPolicy
  id: string
  conversationId: string
  branchId: string
  triggeringMessageId: string
  provider: string
  model: string
  contextWindow: number | null
  maxTokens: number | null
  purpose: RunPurpose
  status: RunStatus
  piSessionFile: string | null
  errorCode: string | null
  executionContext: SpaceExecutionContext | null
  executionProfile: BuddyExecutionProfile
  startedAt: string
  completedAt: string | null
}

export interface RunRow {
  root_run_id: string
  parent_run_id: string | null
  execution_kind: ExecutionKind
  thread_id: string
  generation: number
  model_override_json: string | null
  actor_snapshot_json: string | null
  buddy_id: string
  approval_policy: BuddyApprovalPolicy
  id: string
  conversation_id: string
  branch_id: string
  triggering_message_id: string
  provider: string
  model: string
  context_window: number | null
  max_tokens: number | null
  purpose: RunPurpose
  status: RunStatus
  pi_session_file: string | null
  error_code: string | null
  execution_context_json: string | null
  execution_profile: BuddyExecutionProfile
  started_at: string
  completed_at: string | null
}

export function requireRunRecord(value: unknown, id: string): RunRecord {
  const row = value as RunRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy run was not persisted: ${id}`)
  return toRunRecord(row)
}

export function toRunRecord(row: RunRow): RunRecord {
  return {
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    executionKind: row.execution_kind,
    threadId: row.thread_id,
    generation: row.generation,
    modelOverride: row.model_override_json ? buddyComposerDraftModelSelectionSchema.parse(JSON.parse(row.model_override_json)) : null,
    actorSnapshot: row.actor_snapshot_json ? buddyExecutionDefinitionSchema.parse(JSON.parse(row.actor_snapshot_json)) : null,
    buddyId: row.buddy_id,
    approvalPolicy: row.approval_policy,
    id: row.id,
    conversationId: row.conversation_id,
    branchId: row.branch_id,
    triggeringMessageId: row.triggering_message_id,
    provider: row.provider,
    model: row.model,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    purpose: row.purpose,
    status: row.status,
    piSessionFile: row.pi_session_file,
    errorCode: row.error_code,
    executionContext: row.execution_context_json
      ? spaceExecutionContextSchema.parse(JSON.parse(row.execution_context_json))
      : null,
    executionProfile: row.execution_profile,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}
