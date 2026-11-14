import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buddyUserContentV1Schema } from '../../../shared/conversation/buddyUserContent'
import { buddyInputDeliverySchema } from '../../../shared/conversation/chatApi'
import { buddyComposerDraftDiscardSchema, buddyComposerDraftOpenSchema, buddyComposerDraftSaveSchema, buddyComposerDraftScopeSchema } from '../../../shared/conversation/composerDraft'
import { conversationRequestSchemas } from '../../../shared/conversation/conversationApi'
import { conversationArchivePolicySchema, conversationArchiveTargetSchema } from '../../../shared/conversation/conversationArchiveApi'
import { submitInputIntentSchema } from '../../../shared/conversation/submittedInput'
import { taskMarkClearSchema, taskMarkInputSchema, taskMarkReadSchema } from '../../../shared/conversation/taskMarkApi'

import { uploadCommandIntents } from '../../../shared/privateNetwork/uploads'
import { productCommandIntents } from '../../../shared/productProtocol/methods'
import { userQuestionRpc } from '../../../shared/questions/userQuestionApi'
import { desktopOpenIntentSchema } from '../../../shared/service/localServiceProtocol'

export const COMMAND_FINGERPRINT_VERSION = 1 as const
export const PRODUCT_COMMAND_FINGERPRINT_VERSION = 2 as const
export const productCommandFingerprint = Symbol('productCommandFingerprint')

export interface ProductCommandFingerprint {
  version: typeof PRODUCT_COMMAND_FINGERPRINT_VERSION
  fingerprint: string
}

const id = z.string().min(1).max(256)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const queueTarget = z.object({ conversationId: id, branchId: id, id, expectedRevision: revision }).strict()
const draft = z.object({ draftId: id, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()

const copyTargetScope = z.union([
  buddyComposerDraftScopeSchema.options[1],
  buddyComposerDraftScopeSchema.options[2],
  buddyComposerDraftScopeSchema.options[3],
  buddyComposerDraftScopeSchema.options[4],
  buddyComposerDraftScopeSchema.options[5],
  z.object({ kind: z.literal('task'), spaceId: id.nullable() }).strict(),
])

export const commandIntentSchemas = {
  ...uploadCommandIntents,
  'questions.answer': userQuestionRpc.answer.input,
  'questions.cancel': userQuestionRpc.cancel.input,
  'questions.retry': userQuestionRpc.retry.input,
  'desktop.open': desktopOpenIntentSchema,
  'chat.submitInput': submitInputIntentSchema(buddyUserContentV1Schema),
  'uploads.create': uploadCommandIntents['uploads.create'].extend({ expectedRevision: revision }),
  'uploads.adopt': uploadCommandIntents['uploads.adopt'].extend({ expectedRevision: revision }),
  'chat.startTurn': draft.extend({ buddyId: id.optional(), delivery: buddyInputDeliverySchema.optional() }).strict(),
  'chat.editUserMessage': draft.extend({ conversationId: id, userMessageId: id }).strict(),
  'chat.regenerateAssistant': z.object({ conversationId: id, sourceRunId: id }).strict(),
  'chat.executeCommand': draft,
  'chat.queue.enqueue': draft.extend({ delivery: buddyInputDeliverySchema.optional() }).strict(),
  'chat.queue.cancel': queueTarget,
  'chat.queue.continue': queueTarget,
  'chat.queue.steer': queueTarget.extend({ targetRunId: id, expectedRunGeneration: revision }).strict(),
  'chat.cancel': z.object({ runId: id, expectedRunGeneration: revision }).strict(),
  'composerDrafts.open': buddyComposerDraftOpenSchema.unwrap().extend({ expectedSlotRevision: revision }).strict(),
  'composerDrafts.copy': z.object({ sourceDraftId: id, expectedSourceRevision: revision, targetScope: copyTargetScope, expectedSlotRevision: revision, recoveredInput: buddyComposerDraftSaveSchema.unwrap().pick({ content: true, executionConfig: true, modelSelection: true, participants: true }).optional() }).strict(),
  'composerDrafts.save': buddyComposerDraftSaveSchema,
  'composerDrafts.discard': buddyComposerDraftDiscardSchema,
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
  'conversations.setModelSelection': conversationRequestSchemas.conversationModelSelection.extend({ expectedRevision: revision, expectedRunGeneration: revision.optional(), expectedRunModelSelection: conversationRequestSchemas.conversationModelSelection.shape.modelSelection.optional() }).strict().refine(input => input.targetRunId ? (input.expectedRunGeneration !== undefined && input.expectedRunModelSelection !== undefined) : input.expectedActiveRun !== undefined),
  'taskMarks.create': taskMarkInputSchema,
  'taskMarks.update': taskMarkInputSchema.extend({ id, expectedRevision: revision }).strict(),
  'taskMarks.delete': z.object({ id, expectedRevision: revision }).strict(),
  'taskMarks.assign': z.object({ conversationId: id, markId: id.nullable(), expectedAssignmentRevision: revision }).strict(),
  'taskMarks.setRead': taskMarkReadSchema,
  'taskMarks.clear': taskMarkClearSchema.extend({ expectedAssignmentRevision: revision }).strict(),
  'runtime.stop': z.object({ targetServiceInstanceId: id, scope: z.enum(['stop_service', 'keep_service']) }).strict(),
} as const

export type InputCommandMethod = keyof typeof commandIntentSchemas
export type InputCommandIntent<Method extends InputCommandMethod> = z.output<typeof commandIntentSchemas[Method]>

export function fingerprintCommandIntent<Method extends InputCommandMethod>(method: Method, value: unknown) {
  const intent = commandIntentSchemas[method].parse(value) as InputCommandIntent<Method>
  const bytes = canonicalCommandJson(intent)
  return { version: COMMAND_FINGERPRINT_VERSION, fingerprint: createHash('sha256').update(bytes, 'utf8').digest('hex'), intent }
}

export function fingerprintProductCommandIntent(method: keyof typeof productCommandIntents, value: unknown): ProductCommandFingerprint {
  const intent = productCommandIntents[method].parse(value)
  return { version: PRODUCT_COMMAND_FINGERPRINT_VERSION, fingerprint: createHash('sha256').update(canonicalCommandJson(intent), 'utf8').digest('hex') }
}

export function canonicalCommandJson(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (input: unknown, depth: number): string => {
    if (depth > 64)
      throw new TypeError('Command intent nesting exceeds its limit')
    if (input === null || typeof input === 'boolean' || typeof input === 'string')
      return JSON.stringify(input)
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input)))
        throw new TypeError('Command intent numbers must be finite and exactly representable')
      return JSON.stringify(input)
    }
    if (!input || typeof input !== 'object')
      throw new TypeError('Command intent must contain JSON values')
    if (ancestors.has(input))
      throw new TypeError('Command intent cannot contain cycles')
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        return `[${Array.from(input, child => encode(child, depth + 1)).join(',')}]`
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
        throw new TypeError('Command intent objects must contain plain JSON data')
      if (Object.getOwnPropertySymbols(input).length)
        throw new TypeError('Command intent cannot contain symbol keys')
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${encode((input as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    }
    finally {
      ancestors.delete(input)
    }
  }
  return encode(value, 0)
}
