import { z } from 'zod'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../conversation/buddyMessageContent'
import { idSchema } from '../runtime/apiValidation'

export const EXECUTION_MAILBOX_ENTRY_TYPE = 'lexora.execution.message.v1'
export const EXECUTION_DELEGATION_TOOL_NAME = 'lexora_agents'

export const executionPhaseSchema = z.enum(['queued', 'preparing', 'working', 'waiting', 'closing', 'closed'])
export type ExecutionPhase = z.infer<typeof executionPhaseSchema>

const messageFields = {
  messageId: z.string().min(1).max(256),
  sourceRunId: idSchema,
  sourceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetRunId: idSchema,
  targetGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
}

export const executionMailboxMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...messageFields, kind: z.literal('result') }).strict(),
  z.object({ ...messageFields, kind: z.literal('question'), questionId: z.string().min(1).max(256), audience: z.enum(['caller', 'user']).optional() }).strict(),
  z.object({ ...messageFields, kind: z.literal('answer'), questionId: z.string().min(1).max(256) }).strict(),
  z.object({ ...messageFields, kind: z.literal('supplement'), origin: z.literal('user').optional() }).strict(),
])

const draftFields = {
  messageId: messageFields.messageId,
  targetRunId: messageFields.targetRunId,
  targetGeneration: messageFields.targetGeneration,
  text: messageFields.text,
}
export const executionMailboxDraftSchema = z.discriminatedUnion('kind', [
  z.object({ ...draftFields, kind: z.literal('result') }).strict(),
  z.object({ ...draftFields, kind: z.literal('question'), questionId: z.string().min(1).max(256), audience: z.enum(['caller', 'user']).optional() }).strict(),
  z.object({ ...draftFields, kind: z.literal('answer'), questionId: z.string().min(1).max(256) }).strict(),
  z.object({ ...draftFields, kind: z.literal('supplement'), origin: z.literal('user').optional() }).strict(),
])
export type ExecutionMailboxDraft = Readonly<z.infer<typeof executionMailboxDraftSchema>>

export type ExecutionMailboxMessage = Readonly<z.infer<typeof executionMailboxMessageSchema>>

export const executionMailboxReceiptSchema = z.object({
  sourceRunId: idSchema,
  messageId: z.string().min(1).max(256),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  contextEntryId: z.string().min(1).max(256),
}).strict()
export type ExecutionMailboxReceipt = Readonly<z.infer<typeof executionMailboxReceiptSchema>>

export const executionMailboxRejectionSchema = executionMailboxReceiptSchema.omit({ contextEntryId: true }).extend({
  reason: z.enum(['target_closed', 'generation_expired', 'branch_changed', 'cancelled', 'deleted']),
}).strict()

export const executionMailboxEventSchemas = {
  'execution.mailbox.sent': executionMailboxMessageSchema,
  'execution.mailbox.accepted': executionMailboxReceiptSchema,
  'execution.mailbox.consumed': executionMailboxReceiptSchema,
  'execution.mailbox.rejected': executionMailboxRejectionSchema,
} as const
