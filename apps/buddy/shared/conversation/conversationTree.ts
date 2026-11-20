import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { artifactSchema } from '../artifacts/artifactApi'
import { runStatusSchema } from '../runs/runApi'
import { idSchema, timestampSchema } from '../runtime/apiValidation'
import { runTokenUsageSchema } from '../usage/runTokenUsage'
import { attachmentSchema } from './attachmentApi'
import { buddyMessageQuoteSchema } from './buddyUserContent'
import { conversationResponseSchemas } from './conversationApi'

export const CONVERSATION_QUOTE_PREVIEW_LENGTH = 160
const conversationQuotePreviewSchema = buddyMessageQuoteSchema.unwrap().extend({
  text: z.string().max(CONVERSATION_QUOTE_PREVIEW_LENGTH),
})

export const conversationTreeNodeSchema = z.object({
  id: idSchema,
  parentId: idSchema.nullable(),
  branchId: idSchema,
  kind: z.enum(['question', 'answer']),
  messageId: idSchema.nullable(),
  runId: idSchema.nullable(),
  text: z.string().max(640),
  quotes: z.array(conversationQuotePreviewSchema).max(3),
  quoteCount: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).max(3),
  attachmentCount: z.number().int().nonnegative(),
  artifacts: z.array(artifactSchema).max(3),
  artifactCount: z.number().int().nonnegative(),
  metadata: z.object({
    modelId: idSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    usage: runTokenUsageSchema.nullable(),
  }).strict().nullable(),
  status: runStatusSchema.nullable(),
  active: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  attempts: z.array(z.object({ runId: idSchema, status: runStatusSchema }).strict()),
}).strict()

export const conversationTreeSchema = z.object({
  conversationId: idSchema,
  activeBranchId: idSchema.nullable(),
  headId: idSchema.nullable(),
  nodes: z.array(conversationTreeNodeSchema),
}).strict()

export type LocalConversationTree = DeepReadonly<z.infer<typeof conversationTreeSchema>>
export type LocalConversationTreeNode = DeepReadonly<z.infer<typeof conversationTreeNodeSchema>>

export const conversationNodeDetailRequestSchema = z.discriminatedUnion('kind', [
  z.object({ conversationId: idSchema, kind: z.literal('question'), messageId: idSchema }).strict(),
  z.object({ conversationId: idSchema, kind: z.literal('answer'), runId: idSchema, eventView: z.literal('paged').optional() }).strict(),
])
export type ConversationNodeDetailRequest = z.infer<typeof conversationNodeDetailRequestSchema>

export const conversationTreeRpc = {
  detail: {
    method: 'conversations.getNodeDetail',
    input: conversationNodeDetailRequestSchema,
    response: conversationResponseSchemas.timelinePage,
  },
  get: {
    method: 'conversations.getTree',
    input: z.object({ conversationId: idSchema }).strict(),
    response: conversationTreeSchema,
  },
} as const
