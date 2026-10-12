import type { BuddyServiceTier, BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'

export interface ConversationModelSelection {
  modelId: string
  providerId: string
  reasoning: BuddyThinkingLevel | null
  serviceTier: BuddyServiceTier | null
}

export interface ConversationRecord {
  buddyId: string
  approvalPolicy: BuddyApprovalPolicy
  id: string
  spaceId: string | null
  title: string | null
  activeBranchId: string | null
  createdAt: string
  executionProfile: BuddyExecutionProfile
  modelSelection: ConversationModelSelection | null
  origin: 'automation' | 'interactive'
  deletedAt: string | null
  updatedAt: string
}

export interface ConversationRow {
  buddy_id: string
  approval_policy: BuddyApprovalPolicy
  id: string
  space_id: string | null
  title: string | null
  active_branch_id: string | null
  created_at: string
  execution_profile: BuddyExecutionProfile
  actor_model_selection_json?: string | null
  origin: ConversationRecord['origin']
  deleted_at: string | null
  updated_at: string
}

export const CONVERSATION_CURRENT_MODEL_SELECTION_SQL = '(SELECT model_selection_json FROM conversation_members WHERE conversation_id = conversations.id AND actor_id = conversations.buddy_id)'

export function requireConversationRecord(value: unknown, id: string): ConversationRecord {
  const row = value as ConversationRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy conversation was not persisted: ${id}`)
  return toConversationRecord(row)
}

export function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    buddyId: row.buddy_id,
    approvalPolicy: row.approval_policy,
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    activeBranchId: row.active_branch_id,
    createdAt: row.created_at,
    executionProfile: row.execution_profile,
    modelSelection: row.actor_model_selection_json
      ? JSON.parse(row.actor_model_selection_json) as ConversationModelSelection
      : null,
    origin: row.origin,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
  }
}
