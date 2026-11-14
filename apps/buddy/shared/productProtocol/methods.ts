import type { ZodType } from 'zod'
import { z } from 'zod'
import { buddyInputDeliverySchema } from '../conversation/chatApi'
import { buddyComposerDraftOpenSchema, buddyComposerDraftSaveSchema, buddyComposerDraftScopeSchema } from '../conversation/composerDraft'
import { conversationRequestSchemas } from '../conversation/conversationApi'
import { conversationArchivePolicySchema, conversationArchiveTargetSchema } from '../conversation/conversationArchiveApi'
import { submitInputIntentSchema } from '../conversation/submittedInput'
import { taskMarkClearSchema, taskMarkInputSchema, taskMarkReadSchema } from '../conversation/taskMarkApi'
import { resourceDownloadSchema, resourcePrepareSchema } from '../privateNetwork/resources'
import { uploadCommandIntents, uploadGetSchema, uploadStateSchema } from '../privateNetwork/uploads'
import { userQuestionRpc } from '../questions/userQuestionApi'
import { desktopOpenIntentSchema } from '../service/localServiceProtocol'
import { productEditableContentSchema } from './content'
import { PRODUCT_QUERY_METHODS } from './queries'
import { productCommandLookupSchema, productCommandResultSchema } from './receipts'
import { productIdSchema as id, productRevisionSchema as revision } from './scalars'

const draft = z.object({ draftId: id, expectedRevision: revision }).strict()
const recoveredInput = z.object({
  content: productEditableContentSchema,
  executionConfig: buddyComposerDraftSaveSchema.unwrap().shape.executionConfig,
  modelSelection: buddyComposerDraftSaveSchema.unwrap().shape.modelSelection,
  participants: buddyComposerDraftSaveSchema.unwrap().shape.participants,
}).strict()
const queue = z.object({ conversationId: id, branchId: id, id, expectedRevision: revision }).strict()
const copyScope = z.union([
  ...buddyComposerDraftScopeSchema.options.slice(1),
  z.object({ kind: z.literal('task'), spaceId: id.nullable() }).strict(),
])
const envelope = (intent: ZodType) => z.object({ dataGeneration: id, commandId: id, expectedServiceInstanceId: id, intent }).strict()
const command = (intent: ZodType) => ({ input: envelope(intent), output: productCommandResultSchema, role: 'owner', command: true, ready: true } as const)
export const productCommandIntents = {
  ...uploadCommandIntents,
  'questions.answer': userQuestionRpc.answer.input,
  'questions.cancel': userQuestionRpc.cancel.input,
  'questions.retry': userQuestionRpc.retry.input,
  'desktop.open': desktopOpenIntentSchema,
  'chat.submitInput': submitInputIntentSchema(productEditableContentSchema),
  'chat.startTurn': draft.extend({ buddyId: id.optional(), delivery: buddyInputDeliverySchema.optional() }).strict(),
  'chat.editUserMessage': draft.extend({ conversationId: id, userMessageId: id }).strict(),
  'chat.regenerateAssistant': z.object({ conversationId: id, sourceRunId: id }).strict(),
  'chat.executeCommand': draft,
  'chat.queue.enqueue': draft.extend({ delivery: buddyInputDeliverySchema.optional() }).strict(),
  'chat.queue.cancel': queue,
  'chat.queue.continue': queue,
  'chat.queue.steer': queue.extend({ targetRunId: id, expectedRunGeneration: revision }).strict(),
  'chat.cancel': z.object({ runId: id, expectedRunGeneration: revision }).strict(),
  'composerDrafts.open': z.object({ ...buddyComposerDraftOpenSchema.unwrap().shape, initialContent: productEditableContentSchema, expectedSlotRevision: revision }).strict(),
  'composerDrafts.save': z.object({ ...buddyComposerDraftSaveSchema.unwrap().shape, content: productEditableContentSchema, expectedRevision: revision }).strict(),
  'composerDrafts.discard': draft,
  'composerDrafts.copy': z.object({ sourceDraftId: id, expectedSourceRevision: revision, targetScope: copyScope, expectedSlotRevision: revision, recoveredInput: recoveredInput.optional() }).strict(),
  'approvals.resolve': z.object({ approvalId: id, runId: id, reviewVersion: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approved', 'denied', 'approved_persistently', 'approved_for_operation', 'approved_for_source', 'approved_for_turn']) }).strict(),
  'conversations.rename': conversationRequestSchemas.conversationRename.extend({ expectedTitleRevision: revision }).strict(),
  'conversations.delete': conversationRequestSchemas.conversationId.extend({ expectedRevision: revision }).strict(),
  'conversations.archive': conversationArchiveTargetSchema.extend({ expectedRevision: revision }).strict(),
  'conversations.restoreArchive': conversationArchiveTargetSchema.extend({ expectedRevision: revision }).strict(),
  'conversations.deleteArchived': conversationArchiveTargetSchema.extend({ expectedRevision: revision }).strict(),
  'conversations.deleteLegacyRemoved': conversationArchiveTargetSchema.extend({ expectedRevision: revision }).strict(),
  'conversations.setArchivePolicy': conversationArchivePolicySchema,
  'conversations.activateBranch': conversationRequestSchemas.conversationBranchActivation.extend({ expectedRevision: revision }).strict(),
  'conversations.setPermissionSettings': conversationRequestSchemas.conversationPermissionSettings.extend({ expectedRevision: revision }).strict(),
  'conversations.setBuddy': conversationRequestSchemas.conversationBuddy.extend({ expectedRevision: revision }).strict(),
  'conversations.addMember': conversationRequestSchemas.conversationBuddy.extend({ expectedRevision: revision }).strict(),
  'conversations.removeMember': conversationRequestSchemas.conversationBuddy.extend({ expectedRevision: revision }).strict(),
  'conversations.moveToSpace': conversationRequestSchemas.conversationMoveToSpace.extend({ expectedRevision: revision }).strict(),
  'conversations.setModelSelection': conversationRequestSchemas.conversationModelSelection.extend({ expectedRevision: revision, expectedRunGeneration: revision.optional(), expectedRunModelSelection: conversationRequestSchemas.conversationModelSelection.shape.modelSelection.optional(), expectedActiveRun: z.object({ runId: id, generation: revision, modelSelection: conversationRequestSchemas.conversationModelSelection.shape.modelSelection }).strict().nullable().optional() }).strict().refine(input => input.targetRunId ? input.expectedRunGeneration !== undefined && input.expectedRunModelSelection !== undefined : input.expectedActiveRun !== undefined),
  'taskMarks.create': taskMarkInputSchema,
  'taskMarks.update': taskMarkInputSchema.extend({ id, expectedRevision: revision }).strict(),
  'taskMarks.delete': z.object({ id, expectedRevision: revision }).strict(),
  'taskMarks.assign': z.object({ conversationId: id, markId: id.nullable(), expectedAssignmentRevision: revision }).strict(),
  'taskMarks.setRead': taskMarkReadSchema.extend({ readRevision: revision }).strict(),
  'taskMarks.clear': taskMarkClearSchema.extend({ readRevision: revision, expectedAssignmentRevision: revision }).strict(),
} as const
export type ProductCommandMethod = keyof typeof productCommandIntents
export const PRODUCT_METHODS = {
  ...PRODUCT_QUERY_METHODS,
  'resources.prepare': { input: resourcePrepareSchema, output: resourceDownloadSchema, role: 'reader', command: false, ready: true },
  'uploads.get': { input: uploadGetSchema, output: uploadStateSchema, role: 'owner', command: false, ready: true },
  ...Object.fromEntries(Object.entries(productCommandIntents).map(([method, intent]) => [method, command(intent)])) as { [M in ProductCommandMethod]: ReturnType<typeof command> },
  'commands.get': { input: z.object({ dataGeneration: id, commandId: id }).strict(), output: productCommandLookupSchema, role: 'owner', command: false, ready: false },
} as const
export type ProductMethod = keyof typeof PRODUCT_METHODS
export interface ProductMethodContract { input: ZodType, output: ZodType, role: 'owner' | 'reader', command: boolean, ready: boolean }

export function getProductMethod(method: string): ProductMethodContract | undefined {
  return Object.hasOwn(PRODUCT_METHODS, method) ? PRODUCT_METHODS[method as ProductMethod] : undefined
}
