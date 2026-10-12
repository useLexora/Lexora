import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema } from '../runtime/apiValidation'
import { buddyUserMessageContentV1Schema } from './buddyUserContent'
import { buddyComposerDraftSendSchema } from './composerDraft'

export const chatQueueItemSchema = z.object({
  buddyId: idSchema,
  id: idSchema,
  conversationId: idSchema,
  branchId: idSchema,
  state: z.enum(['waiting', 'paused']),
  content: buddyUserMessageContentV1Schema,
  attachments: z.array(z.object({ id: idSchema, name: z.string(), mimeType: z.string(), sizeBytes: z.number() }).strict()),
  createdAt: z.string(),
}).strict()
const scope = z.object({ conversationId: idSchema, branchId: idSchema }).strict()
const target = scope.extend({ id: idSchema }).strict()
export const queueReceiptSchema = scope.extend({
  id: idSchema,
  draftReceipt: z.object({ draftId: z.string(), sourceRevision: z.number(), committedRevision: z.number() }).strict(),
}).strict()
export type LocalChatQueueItem = DeepReadonly<z.infer<typeof chatQueueItemSchema>>
export type LocalChatQueueScope = z.infer<typeof scope>
export type LocalChatQueueTarget = z.infer<typeof target>
export type LocalChatQueueReceipt = z.infer<typeof queueReceiptSchema>
export const chatQueueRpc = {
  enqueue: { method: 'chat.queue.enqueue', input: buddyComposerDraftSendSchema, response: queueReceiptSchema },
  list: { method: 'chat.queue.list', input: scope, response: z.array(chatQueueItemSchema) },
  cancel: { method: 'chat.queue.cancel', input: target, response: z.boolean() },
  steer: { method: 'chat.queue.steer', input: target, response: z.boolean() },
} as const satisfies Record<string, RuntimeRequestContract>
