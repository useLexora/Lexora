import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { changeSetSummarySchema } from '../changes/changeApi'
import { extensionActionTimelineSchema } from '../extensions/extensionActionApi'
import { runEventSchema, runOutputSchema, runSchema, runStatusSchema } from '../runs/runApi'
import { approvalPolicySchema, executionProfileSchema, idSchema, nullableTimestampSchema, optionalCursorSchema, optionalLimitSchema, timestampSchema, validationRequestSchemas, validationResponseSchemas } from '../runtime/apiValidation'
import { attachmentSchema } from './attachmentApi'
import { BUDDY_SERVICE_TIERS, BUDDY_THINKING_LEVELS } from './modelSelection'

export const CONVERSATION_CHANGED = 'conversations.changed'

export const conversationTimelineChanged = {
  method: 'conversations.timeline.changed',
  params: z.object({ sourceId: z.uuid(), revision: z.number().int().positive(), conversationId: idSchema, branchId: idSchema }).strict(),
} as const
export type ConversationTimelineChangeNotice = z.infer<typeof conversationTimelineChanged.params>

export const modelSelectionSchema = z.object({
  modelId: idSchema,
  providerId: idSchema,
  reasoning: z.enum(BUDDY_THINKING_LEVELS).nullable(),
  serviceTier: z.enum(BUDDY_SERVICE_TIERS).nullable(),
}).strict()

export const conversationActiveRunModelSchema = z.object({
  runId: idSchema,
  generation: z.number().int().nonnegative(),
  modelSelection: modelSelectionSchema,
}).strict()

export interface ConversationModelMutationTarget {
  actorId?: string
  runId?: string
  expectedRevision?: number
  expectedRunGeneration?: number
  expectedRunModelSelection?: z.infer<typeof modelSelectionSchema> | null
  expectedActiveRun?: z.infer<typeof conversationActiveRunModelSchema> | null
}

export const conversationModelControlsSchema = z.object({
  metadataRevision: z.number().int().nonnegative().optional(),
  current: z.object({
    runId: idSchema,
    generation: z.number().int().nonnegative().optional(),
    actorId: idSchema,
    modelSelection: modelSelectionSchema,
  }).strict().nullable(),
  next: z.object({
    actorId: idSchema,
    isMember: z.boolean(),
    modelSelection: modelSelectionSchema.nullable(),
  }).strict(),
}).strict()

export type ConversationModelControls = DeepReadonly<z.infer<typeof conversationModelControlsSchema>>

export const conversationMemberSchema = z.object({ actorId: idSchema, joinedAt: timestampSchema, metadataRevision: z.number().int().nonnegative().optional() }).strict()
export type LocalConversationMember = DeepReadonly<z.infer<typeof conversationMemberSchema>>

export const conversationSchema = z.object({
  metadataRevision: z.number().int().nonnegative().optional(),
  titleRevision: z.number().int().nonnegative().optional(),
  buddyId: idSchema,
  activeBranchId: z.string().nullable(),
  approvalPolicy: approvalPolicySchema,
  createdAt: timestampSchema,
  deletedAt: nullableTimestampSchema,
  archivedAt: nullableTimestampSchema.optional(),
  executionProfile: executionProfileSchema,
  id: idSchema,
  modelSelection: modelSelectionSchema.nullable(),
  origin: z.enum(['interactive', 'automation']).optional(),
  spaceId: z.string().nullable(),
  title: z.string().nullable(),
  updatedAt: timestampSchema,
}).strict()

export const conversationSummarySchema = conversationSchema.extend({
  activity: z.enum(['idle', 'running', 'awaiting_approval']),
  automationOccurrence: z.object({
    automationId: idSchema,
    occurrenceId: idSchema,
    scheduledFor: timestampSchema,
  }).strict().nullable(),
}).strict()

export const conversationBranchSchema = z.object({
  conversationId: idSchema,
  createdAt: timestampSchema,
  forkedFromMessageId: z.string().nullable(),
  id: idSchema,
  parentBranchId: z.string().nullable(),
}).strict()

export const messageSchema = z.object({
  attachments: z.array(attachmentSchema),
  branchId: idSchema,
  content: z.json(),
  conversationId: idSchema,
  createdAt: timestampSchema,
  id: idSchema,
  inputRunId: idSchema.optional(),
  role: z.enum(['user', 'assistant', 'tool']),
  runId: z.string().nullable(),
  startedAt: timestampSchema.optional(),
}).strict()

export const conversationTimelineItemSchema = z.discriminatedUnion('kind', [
  extensionActionTimelineSchema,
  messageSchema.extend({ kind: z.literal('message') }).strict(),
  z.object({
    branchId: idSchema,
    completedAt: nullableTimestampSchema,
    conversationId: idSchema,
    createdAt: timestampSchema,
    errorCode: z.string().nullable(),
    estimatedTokensAfter: z.number().int().nonnegative().nullable(),
    id: idSchema,
    kind: z.literal('compaction'),
    status: runStatusSchema,
    tokensBefore: z.number().int().nonnegative().nullable(),
  }).strict(),
])

export type LocalConversation = DeepReadonly<z.infer<typeof conversationSchema>>

export type LocalConversationSummary = DeepReadonly<z.infer<typeof conversationSummarySchema>>

export type LocalConversationBranch = DeepReadonly<z.infer<typeof conversationBranchSchema>>

export type LocalMessage = DeepReadonly<z.infer<typeof messageSchema>>

export type LocalMessagePage = DeepReadonly<z.infer<typeof conversationResponseSchemas.messagePage>>

export type LocalConversationTimelineItem = DeepReadonly<z.infer<typeof conversationTimelineItemSchema>>

export type LocalConversationTimelinePage = DeepReadonly<z.infer<typeof conversationResponseSchemas.timelinePage>>

export const conversationListFilterSchema = z.object({
  spaceId: idSchema.nullable().optional(),
  query: z.string().max(512).optional(),
  excludeConversationId: idSchema.optional(),
}).strict()
export type ConversationListFilter = z.infer<typeof conversationListFilterSchema>

export const conversationRequestSchemas = {
  list: validationRequestSchemas.limit.extend({ filter: conversationListFilterSchema.optional() }),
  conversationMutation: z.object({ conversationId: idSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(),
  conversationBranchActivation: z.object({
    expectedRevision: z.number().int().nonnegative().optional(),
    branchId: idSchema,
    conversationId: idSchema,
  }).strict(),
  conversationId: z.object({ conversationId: idSchema }).strict(),
  modelControls: z.object({ conversationId: idSchema, actorId: idSchema.optional() }).strict(),
  conversationMessages: z.object({
    branchId: idSchema.optional(),
    conversationId: idSchema,
    cursor: optionalCursorSchema,
    limit: optionalLimitSchema,
  }).strict(),
  conversationRename: z.object({
    expectedTitleRevision: z.number().int().nonnegative().optional(),
    conversationId: idSchema,
    title: z.string().trim().min(1).max(80),
  }).strict(),
  conversationPermissionSettings: z.object({
    expectedRevision: z.number().int().nonnegative().optional(),
    approvalPolicy: approvalPolicySchema,
    conversationId: idSchema,
    executionProfile: executionProfileSchema,
  }).strict(),
  conversationBuddy: z.object({ conversationId: idSchema, buddyId: idSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(),
  conversationMoveToSpace: z.object({ conversationId: idSchema, spaceId: idSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(),
  conversationModelSelection: z.object({
    expectedActiveRun: conversationActiveRunModelSchema.nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedRunGeneration: z.number().int().nonnegative().optional(),
    expectedRunModelSelection: modelSelectionSchema.nullable().optional(),
    conversationId: idSchema,
    actorId: idSchema.optional(),
    targetRunId: idSchema.optional(),
    modelSelection: modelSelectionSchema.nullable(),
  }).strict(),
  conversationTimeline: z.object({
    branchId: idSchema.optional(),
    conversationId: idSchema,
    cursor: optionalCursorSchema,
    limit: optionalLimitSchema,
  }).strict(),
} as const

export const conversationResponseSchemas = {
  conversation: conversationSchema,
  conversationBranches: z.array(conversationBranchSchema),
  conversations: z.array(conversationSummarySchema),
  messagePage: z.object({
    items: z.array(messageSchema),
    nextCursor: z.string().regex(/^[\w-]+$/).max(2_048).nullable(),
  }).strict(),
  timelinePage: z.object({
    changeSets: z.array(changeSetSummarySchema),
    items: z.array(conversationTimelineItemSchema),
    nextCursor: z.string().regex(/^[\w-]+$/).max(2_048).nullable(),
    outputs: z.array(runOutputSchema),
    runEvents: z.array(runEventSchema),
    runs: z.array(runSchema),
  }).strict(),
} as const

export const conversationsRpc = {
  listMembers: { method: 'conversations.listMembers', input: conversationRequestSchemas.conversationId, response: z.array(conversationMemberSchema) },
  addMember: { method: 'conversations.addMember', input: conversationRequestSchemas.conversationBuddy, response: z.array(conversationMemberSchema) },
  removeMember: { method: 'conversations.removeMember', input: conversationRequestSchemas.conversationBuddy, response: z.array(conversationMemberSchema) },
  list: { method: 'conversations.list', input: conversationRequestSchemas.list, response: conversationResponseSchemas.conversations },
  get: { method: 'conversations.get', input: conversationRequestSchemas.conversationId, response: conversationResponseSchemas.conversation },
  getModelControls: { method: 'conversations.getModelControls', input: conversationRequestSchemas.modelControls, response: conversationModelControlsSchema },
  delete: { method: 'conversations.delete', input: conversationRequestSchemas.conversationMutation, response: validationResponseSchemas.deleted },
  activateBranch: { method: 'conversations.activateBranch', input: conversationRequestSchemas.conversationBranchActivation, response: conversationResponseSchemas.conversation },
  listBranches: { method: 'conversations.listBranches', input: conversationRequestSchemas.conversationId, response: conversationResponseSchemas.conversationBranches },
  listMessages: { method: 'conversations.listMessages', input: conversationRequestSchemas.conversationMessages, response: conversationResponseSchemas.messagePage },
  rename: { method: 'conversations.rename', input: conversationRequestSchemas.conversationRename, response: conversationResponseSchemas.conversation },
  setPermissionSettings: { method: 'conversations.setPermissionSettings', input: conversationRequestSchemas.conversationPermissionSettings, response: conversationResponseSchemas.conversation },
  setBuddy: { method: 'conversations.setBuddy', input: conversationRequestSchemas.conversationBuddy, response: conversationResponseSchemas.conversation },
  moveToSpace: { method: 'conversations.moveToSpace', input: conversationRequestSchemas.conversationMoveToSpace, response: conversationResponseSchemas.conversation },
  setModelSelection: { method: 'conversations.setModelSelection', input: conversationRequestSchemas.conversationModelSelection, response: conversationResponseSchemas.conversation },
  listTimeline: { method: 'conversations.listTimeline', input: conversationRequestSchemas.conversationTimeline, response: conversationResponseSchemas.timelinePage },
} as const satisfies Record<string, RuntimeRequestContract>
