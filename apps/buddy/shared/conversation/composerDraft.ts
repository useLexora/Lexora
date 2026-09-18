import { z } from 'zod'
import { BUDDY_APPROVAL_POLICIES } from '../permissions/approvalPolicy'
import { BUDDY_EXECUTION_PROFILES } from '../permissions/executionProfile'
import { buddyUserContentV1Schema } from './buddyUserContent'
import { BUDDY_SERVICE_TIERS, BUDDY_THINKING_LEVELS } from './modelSelection'

const draftIdentitySchema = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)
const scopeIdentitySchema = z.string().trim().min(1).max(256)

export const buddyComposerDraftScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), draftId: draftIdentitySchema, spaceId: scopeIdentitySchema.nullable() }).strict().readonly(),
  z.object({
    kind: z.literal('message_followup'),
    branchId: draftIdentitySchema,
    conversationId: draftIdentitySchema,
    assistantMessageId: draftIdentitySchema,
  }).strict(),
  z.object({ kind: z.literal('global') }).strict().readonly(),
  z.object({
    kind: z.literal('space'),
    spaceId: scopeIdentitySchema,
  }).strict().readonly(),
  z.object({
    branchId: draftIdentitySchema,
    conversationId: draftIdentitySchema,
    kind: z.literal('conversation_branch'),
  }).strict().readonly(),
  z.object({
    branchId: draftIdentitySchema,
    conversationId: draftIdentitySchema,
    kind: z.literal('message_edit'),
    userMessageId: draftIdentitySchema,
  }).strict().readonly(),
])

export const buddyComposerDraftModelSelectionSchema = z.object({
  modelId: scopeIdentitySchema,
  providerId: scopeIdentitySchema,
  reasoning: z.enum(BUDDY_THINKING_LEVELS).nullable(),
  serviceTier: z.enum(BUDDY_SERVICE_TIERS).nullable(),
}).strict().readonly()

export const buddyComposerDraftExecutionConfigSchema = z.object({
  approvalPolicy: z.enum(BUDDY_APPROVAL_POLICIES),
  executionProfile: z.enum(BUDDY_EXECUTION_PROFILES),
}).strict().readonly()

export const buddyComposerDraftSchema = z.object({
  content: buddyUserContentV1Schema,
  draftId: draftIdentitySchema,
  executionConfig: buddyComposerDraftExecutionConfigSchema,
  modelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
  revision: z.number().int().nonnegative(),
  scope: buddyComposerDraftScopeSchema,
  updatedAt: z.iso.datetime(),
}).strict().readonly()

export const buddyComposerDraftOpenSchema = z.object({
  draftId: draftIdentitySchema,
  initialContent: buddyUserContentV1Schema,
  initialExecutionConfig: buddyComposerDraftExecutionConfigSchema,
  initialModelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
  scope: buddyComposerDraftScopeSchema,
}).strict().readonly()

export const buddyComposerDraftSaveSchema = z.object({
  spaceId: scopeIdentitySchema.nullable().optional(),
  content: buddyUserContentV1Schema,
  draftId: draftIdentitySchema,
  executionConfig: buddyComposerDraftExecutionConfigSchema,
  expectedRevision: z.number().int().nonnegative(),
  modelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
}).strict().readonly()

export const buddyComposerDraftTargetSchema = z.object({
  draftId: draftIdentitySchema,
}).strict().readonly()

export const buddyComposerDraftDiscardSchema = z.object({
  draftId: draftIdentitySchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict().readonly()

export const buddyComposerDraftSendSchema = z.object({
  draftId: draftIdentitySchema,
  expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(128),
}).strict().readonly()

export type BuddyComposerDraft = z.infer<typeof buddyComposerDraftSchema>
export type BuddyComposerDraftDiscard = z.infer<typeof buddyComposerDraftDiscardSchema>
export type BuddyComposerDraftExecutionConfig = z.infer<typeof buddyComposerDraftExecutionConfigSchema>
export type BuddyComposerDraftModelSelection = z.infer<typeof buddyComposerDraftModelSelectionSchema>
export type BuddyComposerDraftOpen = z.infer<typeof buddyComposerDraftOpenSchema>
export type BuddyComposerDraftSave = z.infer<typeof buddyComposerDraftSaveSchema>
export type BuddyComposerDraftScope = z.infer<typeof buddyComposerDraftScopeSchema>
export type BuddyComposerDraftSend = z.infer<typeof buddyComposerDraftSendSchema>

export function buddyComposerDraftScopeKey(scope: BuddyComposerDraftScope): string {
  switch (scope.kind) {
    case 'task': return `draft:${scope.draftId}`
    case 'global': return 'global'
    case 'space': return `space:${scope.spaceId}`
    case 'conversation_branch': return `conversation:${scope.conversationId}:${scope.branchId}`
    case 'message_edit': return `message-edit:${scope.conversationId}:${scope.branchId}:${scope.userMessageId}`
    case 'message_followup': return `message-followup:${scope.conversationId}:${scope.branchId}:${scope.assistantMessageId}`
  }
}
