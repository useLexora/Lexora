import type { ZodType } from 'zod'
import { z } from 'zod'
import { buddyInputDeliverySchema } from '../conversation/chatApi'
import { buddyComposerDraftModelSelectionSchema, buddyComposerDraftSchema, buddyComposerDraftScopeSchema } from '../conversation/composerDraft'
import { conversationBranchSchema, conversationSchema, conversationSummarySchema, modelSelectionSchema } from '../conversation/conversationApi'
import { conversationArchiveItemSchema, conversationArchivePolicySchema, conversationArchiveQuerySchema } from '../conversation/conversationArchiveApi'
import { taskMarkSchema, taskMarkStateSchema } from '../conversation/taskMarkApi'
import { executionPhaseSchema } from '../executions/executionApi'
import { userQuestionRequestSchema } from '../questions/userQuestionApi'
import { publicRunEventSchema } from '../runs/publicRunEvent'
import { runStatusSchema } from '../runs/runApi'
import { timestampSchema } from '../runtime/apiValidation'
import { productReadActivityStepDetailInputSchema, productReadActivityStepDetailResultSchema } from './activityStepDetail'
import { productBuddyAvatarSchema } from './avatars'
import { productContentSchema } from './content'
import { PRODUCT_LIMITS } from './limits'
import { productReadLiveTextInputSchema, productReadLiveTextResultSchema, productReadSavedTextInputSchema } from './messageText'
import { productIdSchema as id, productRevisionSchema as revision } from './scalars'
import { productActivityStepsInputSchema, productActivityStepsPageSchema, productTurnWindowInputSchema, productTurnWindowSchema } from './turns'
import { productApprovalDecisionSchema, productApprovalSchema, productMessageSchema, productModelSchema, productModelSnapshotSchema, productProviderSchema, productQueueItemSchema, productResourceSchema, productRunEventSchema, productRunSchema } from './views'

export { productRunSchema } from './views'

export const productPageInputSchema = z.object({ limit: z.number().int().min(1).max(PRODUCT_LIMITS.pageItems).default(PRODUCT_LIMITS.pageItems), cursor: z.string().max(4096).nullable().default(null) }).strict()
export function productPageSchema<T extends ZodType>(item: T) {
  return z.object({ items: z.array(item).max(PRODUCT_LIMITS.pageItems), nextCursor: z.string().max(4096).nullable() }).strict()
}
export const productTaskSchema = conversationSchema.omit({ metadataRevision: true, titleRevision: true, archivedAt: true }).extend({ revision, titleRevision: revision, lastActivityAt: timestampSchema }).strict()
export const productTaskSummarySchema = conversationSummarySchema.omit({ metadataRevision: true, titleRevision: true, archivedAt: true }).extend({ revision, titleRevision: revision, unread: z.boolean().optional(), previewText: z.string().max(240).optional(), previewBranchId: id.optional(), resultBranchId: id.optional(), resultRunId: id.optional(), lastRunStatus: runStatusSchema.nullable().optional(), pendingQuestionCount: z.number().int().nonnegative().optional() }).strict()
export const productBranchSchema = conversationBranchSchema.extend({ pendingQuestionCount: z.number().int().nonnegative().optional(), pendingApprovalCount: z.number().int().nonnegative().optional(), runningCount: z.number().int().nonnegative().optional(), queuedCount: z.number().int().nonnegative().optional() }).strict()
export const productQuestionSchema = userQuestionRequestSchema.omit({ toolCallId: true, rootRunId: true }).strict()
export const productDraftSchema = z.object({ ...buddyComposerDraftSchema.unwrap().shape, content: productContentSchema, revision, ownerDeviceId: id, writable: z.boolean(), resources: z.array(productResourceSchema).max(16) }).strict()
export const productRunExecutionSchema = z.object({ runId: id, generation: revision, phase: executionPhaseSchema, cancelRequested: z.boolean(), resources: z.enum(['occupied', 'released', 'unknown']) }).strict()
export const productTaskMarkSchema = taskMarkSchema.extend({ revision }).strict()
export const productTaskMarkStateSchema = taskMarkStateSchema.extend({ assignmentRevision: revision, readRevision: revision }).strict()
const query = (input: ZodType, output: ZodType) => ({ input, output, role: 'reader', command: false, ready: false } as const)
export const productConversationArchiveItemSchema = conversationArchiveItemSchema.omit({ metadataRevision: true }).extend({ revision }).strict()
export const productConversationArchivePageSchema = productPageSchema(productConversationArchiveItemSchema)
export const productBuddyProfileSchema = z.object({ id, name: z.string().max(80), description: z.string(), enabled: z.boolean(), deleted: z.boolean(), revision }).strict()
export const productBuddyPageSchema = productPageSchema(productBuddyProfileSchema).extend({ catalogRevision: revision, defaultBuddyId: id })
export const productMemberPageSchema = productPageSchema(z.object({ actorId: id, profile: productBuddyProfileSchema, modelSelection: buddyComposerDraftModelSelectionSchema.nullable(), modelSelectionSource: z.enum(['legacy', 'explicit', 'snapshot']).nullable(), joinedAt: z.string() }).strict()).extend({ conversationId: id, buddyId: id, revision })
const searchIdentity = { conversationId: id, branchId: id, title: z.string().nullable(), spaceId: id.nullable() }
export const productSearchHitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), ...searchIdentity }).strict(),
  z.object({ kind: z.literal('message'), ...searchIdentity, messageId: id, role: z.enum(['user', 'assistant']), createdAt: z.string(), snippet: z.string().max(320) }).strict(),
])
export const productSearchInputSchema = productPageInputSchema.extend({ query: z.string().trim().min(1).max(200), spaceId: id.nullable().optional(), conversationId: id.optional(), scope: z.enum(['active', 'archived']).default('active') })
export const productSearchPageSchema = productPageSchema(productSearchHitSchema).extend({ partial: z.boolean(), skippedOversized: z.number().int().nonnegative() })
export const productQueueControlSchema = z.object({
  id,
  revision,
  delivery: buddyInputDeliverySchema.nullable(),
  allowedActions: z.array(z.enum(['cancel', 'continue', 'steer'])).max(3),
  steerTarget: z.object({ runId: id, generation: revision }).strict().nullable(),
  blockedReason: z.enum(['target_unavailable', 'input_incompatible', 'busy', 'service_unavailable', 'input_unavailable', 'archived']).nullable(),
}).strict()
export const productQueueControlsInputSchema = productPageInputSchema.extend({ conversationId: id, branchId: id })
export const productQueueControlsPageSchema = productPageSchema(productQueueControlSchema)
export type ProductQueueControl = z.infer<typeof productQueueControlSchema>
export type ProductQueueControlsInput = z.infer<typeof productQueueControlsInputSchema>
export const productRecentWindowSchema = productPageSchema(productMessageSchema).extend({ conversationId: id, branchId: id, hasMore: z.boolean() })
export const productMessageWindowSchema = productPageSchema(productMessageSchema).extend({ conversationId: id, branchId: id, anchorMessageId: id, hasLater: z.boolean() })
export type ProductSearchInput = z.infer<typeof productSearchInputSchema>
export type ProductSearchPage = z.infer<typeof productSearchPageSchema>
export type ProductBuddyProfile = z.infer<typeof productBuddyProfileSchema>
export type ProductMemberPage = z.infer<typeof productMemberPageSchema>
export type ProductMessageWindow = z.infer<typeof productMessageWindowSchema>
export const productModelControlsInputSchema = z.object({ conversationId: id, branchId: id, actorId: id }).strict()
export const productModelControlsSchema = productModelControlsInputSchema.extend({
  revision,
  modelSelection: modelSelectionSchema.nullable(),
  activeRun: z.object({ runId: id, generation: revision, modelSelection: modelSelectionSchema }).strict().nullable(),
})
export const PRODUCT_QUERY_METHODS = {
  'conversations.readLiveText': query(productReadLiveTextInputSchema, productReadLiveTextResultSchema),
  'conversations.readSavedText': query(productReadSavedTextInputSchema, productReadLiveTextResultSchema),
  'conversations.readActivityStepDetail': query(productReadActivityStepDetailInputSchema, productReadActivityStepDetailResultSchema),
  'conversations.getTurnWindow': query(productTurnWindowInputSchema, productTurnWindowSchema),
  'conversations.listActivitySteps': query(productActivityStepsInputSchema, productActivityStepsPageSchema),
  'conversations.getModelControls': query(productModelControlsInputSchema, productModelControlsSchema),
  'conversations.getQueueControls': query(productQueueControlsInputSchema, productQueueControlsPageSchema),
  'buddies.list': query(productPageInputSchema, productBuddyPageSchema),
  'conversations.listMembers': query(productPageInputSchema.extend({ conversationId: id }), productMemberPageSchema),
  'conversations.search': query(productSearchInputSchema, productSearchPageSchema),
  'conversations.getRecentWindow': query(z.object({ conversationId: id, branchId: id }).strict(), productRecentWindowSchema),
  'conversations.getReplyTarget': query(z.object({ conversationId: id, branchId: id, messageId: id }).strict(), z.object({ resultRunId: id.nullable() }).strict()),
  'conversations.getMessageWindow': query(z.object({ conversationId: id, branchId: id, messageId: id, limit: z.number().int().min(2).max(PRODUCT_LIMITS.pageItems).default(50) }).strict(), productMessageWindowSchema),
  'buddies.getAvatars': query(z.object({ buddyIds: z.array(id).min(1).max(PRODUCT_LIMITS.pageItems) }).strict(), z.object({ items: z.array(productBuddyAvatarSchema).max(PRODUCT_LIMITS.pageItems) }).strict()),
  'service.host': query(z.object({}).strict(), z.object({ platform: z.enum(['darwin', 'win32', 'linux', 'other']) }).strict()),
  'service.info': query(z.object({}).strict(), z.object({ name: z.string().min(1).max(253) }).strict()),
  'conversations.listArchived': { ...query(conversationArchiveQuerySchema.extend({ limit: productPageInputSchema.shape.limit, cursor: productPageInputSchema.shape.cursor }), productConversationArchivePageSchema), role: 'owner' },
  'conversations.getArchivePolicy': { ...query(z.object({}).strict(), conversationArchivePolicySchema), role: 'owner' },
  'questions.list': query(productPageInputSchema.extend({ conversationId: id, branchId: id }), productPageSchema(productQuestionSchema)),
  'spaces.list': query(productPageInputSchema, productPageSchema(z.object({ id, name: z.string().min(1), memoryScope: z.enum(['personal_and_space', 'space_only']) }).strict())),
  'conversations.listMessages': query(productPageInputSchema.extend({ conversationId: id, branchId: id }), productPageSchema(productMessageSchema)),
  'runs.listTranscriptEvents': query(productPageInputSchema.extend({ runId: id, afterSequence: revision, throughSequence: revision }), productPageSchema(publicRunEventSchema)),
  'runs.listOutputs': query(productPageInputSchema.extend({ runId: id, branchId: id }), productPageSchema(productResourceSchema)),
  'runs.listEvents': query(productPageInputSchema.extend({ runId: id, throughSequence: revision.optional() }), productPageSchema(productRunEventSchema)),
  'chat.queue.list': query(productPageInputSchema.extend({ conversationId: id, branchId: id }), productPageSchema(productQueueItemSchema)),
  'approvals.get': query(z.object({ approvalId: id }).strict(), productApprovalSchema.nullable()),
  'approvals.getDecision': query(z.object({ approvalId: id }).strict(), productApprovalDecisionSchema.nullable()),
  'approvals.list': query(productPageInputSchema.extend({ conversationId: id.optional(), branchId: id.optional(), runId: id.optional(), status: z.enum(['pending', 'approved', 'denied', 'cancelled']).optional() }), productPageSchema(productApprovalSchema)),
  'resources.get': query(z.object({ resourceId: id }).strict(), productResourceSchema.nullable()),
  'resources.list': query(productPageInputSchema.extend({ conversationId: id }), productPageSchema(productResourceSchema)),
  'providers.getInputSelection': query(z.object({ conversationId: id.optional() }).strict(), z.object({ modelSelection: modelSelectionSchema.nullable() }).strict()),
  'providers.list': query(productPageInputSchema, productPageSchema(productProviderSchema)),
  'providers.listModels': query(productPageInputSchema.extend({ providerId: id.optional() }), productPageSchema(productModelSchema)),
  'providers.getModelSnapshot': query(z.object({}).strict(), productModelSnapshotSchema),
  'taskMarks.list': query(productPageInputSchema, productPageSchema(productTaskMarkSchema)),
  'taskMarks.states': query(z.object({ conversationIds: z.array(id).max(PRODUCT_LIMITS.pageItems) }).strict(), z.array(productTaskMarkStateSchema).max(PRODUCT_LIMITS.pageItems)),
  'conversations.list': query(productPageInputSchema.extend({ spaceId: id.nullable().optional() }), productPageSchema(productTaskSummarySchema)),
  'conversations.get': query(z.object({ conversationId: id }).strict(), productTaskSchema.nullable()),
  'conversations.listBranches': query(productPageInputSchema.extend({ conversationId: id }), productPageSchema(productBranchSchema)),
  'composerDrafts.get': query(z.object({ draftId: id }).strict(), productDraftSchema.nullable()),
  'composerDrafts.list': query(productPageInputSchema, productPageSchema(productDraftSchema)),
  'composerDrafts.find': query(z.object({ scope: buddyComposerDraftScopeSchema }).strict(), z.object({ draft: productDraftSchema.nullable(), slotRevision: revision }).strict()),
  'runs.get': query(z.object({ runId: id }).strict(), productRunSchema.nullable()),
  'runs.getExecutionState': query(z.object({ runId: id }).strict(), productRunExecutionSchema.nullable()),
  'runs.list': query(productPageInputSchema.extend({ conversationId: id, branchId: id }), productPageSchema(productRunSchema)),
} as const
