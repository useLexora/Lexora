import { z } from 'zod'
import { productPhaseSchema } from './identity'
import { productTextAppendSchema } from './messageText'
import { productDraftSchema, productQuestionSchema, productRecentWindowSchema, productRunSchema, productTaskSchema, productTaskSummarySchema } from './queries'
import { productIdSchema } from './scalars'
import { productActivityGroupSchema, productTurnMessageSchema } from './turns'
import { productApprovalSchema, productMessageSchema, productQueueItemSchema, productRunEventSchema } from './views'

const remove = z.object({ kind: z.literal('remove'), id: productIdSchema }).strict()
export const productTaskIndexChangeSchema = z.union([remove, z.object({ kind: z.literal('upsert'), value: productTaskSummarySchema }).strict()])
export const productDraftIndexChangeSchema = z.union([remove, z.object({ kind: z.literal('upsert'), value: productDraftSchema }).strict()])
export const productApprovalInboxChangeSchema = z.union([remove, z.object({ kind: z.literal('upsert'), value: productApprovalSchema }).strict()])
export const productQuestionChangeSchema = z.union([remove, z.object({ kind: z.literal('upsert'), value: productQuestionSchema }).strict()])
const taskItem = z.object({ entity: z.literal('task'), value: productTaskSchema }).strict()
const executionItems = [
  z.object({ entity: z.literal('run'), value: productRunSchema }).strict(),
  z.object({ entity: z.literal('queue'), value: productQueueItemSchema }).strict(),
  z.object({ entity: z.literal('approval'), value: productApprovalSchema }).strict(),
] as const
const historyWindow = z.object({ entity: z.literal('historyWindow'), value: productRecentWindowSchema.omit({ items: true }) }).strict()
export const productConversationItemSchema = z.discriminatedUnion('entity', [taskItem, z.object({ entity: z.literal('message'), value: productMessageSchema }).strict(), ...executionItems])
export const productConversationWindowItemSchema = z.union([productConversationItemSchema, historyWindow])
export const productConversationChangeSchema = z.union([
  z.object({ kind: z.literal('upsert'), item: productConversationItemSchema }).strict(),
  z.object({ kind: z.literal('remove'), entity: z.enum(['task', 'message', 'run', 'queue', 'approval']), id: productIdSchema }).strict(),
  z.object({ kind: z.literal('event'), event: productRunEventSchema }).strict(),
])
const turnItem = z.discriminatedUnion('entity', [
  taskItem,
  ...executionItems,
  z.object({ entity: z.literal('message'), value: productTurnMessageSchema }).strict(),
  z.object({ entity: z.literal('activityGroup'), value: productActivityGroupSchema }).strict(),
])
export const productConversationTurnsItemSchema = z.union([turnItem, historyWindow])
export const productConversationTurnsChangeSchema = z.union([
  productTextAppendSchema,
  z.object({ kind: z.literal('upsert'), item: turnItem }).strict(),
  z.object({ kind: z.literal('remove'), entity: z.enum(['task', 'message', 'run', 'queue', 'approval', 'activityGroup']), id: productIdSchema }).strict(),
  z.object({ kind: z.literal('event'), event: productRunEventSchema.extend({ type: z.literal('output.produced') }) }).strict(),
])
export const productServiceStateSchema = z.object({ phase: productPhaseSchema }).strict()
export const PRODUCT_TOPIC_SCHEMAS = {
  taskIndex: { item: productTaskSummarySchema, change: productTaskIndexChangeSchema },
  draftIndex: { item: productDraftSchema, change: productDraftIndexChangeSchema },
  draft: { item: productDraftSchema, change: productDraftIndexChangeSchema },
  conversation: { item: productConversationItemSchema, change: productConversationChangeSchema },
  conversationWindow: { item: productConversationWindowItemSchema, change: productConversationChangeSchema },
  conversationTurns: { item: productConversationTurnsItemSchema, change: productConversationTurnsChangeSchema },
  questions: { item: productQuestionSchema, change: productQuestionChangeSchema },
  approvalInbox: { item: productApprovalSchema, change: productApprovalInboxChangeSchema },
  serviceState: { item: productServiceStateSchema, change: productServiceStateSchema },
} as const
export type ProductTopic = { kind: 'taskIndex' | 'draftIndex' | 'approvalInbox' | 'serviceState' } | { kind: 'draft', draftId: string } | { kind: 'conversation' | 'conversationWindow' | 'conversationTurns' | 'questions', conversationId: string, branchId: string }
export function formatProductTopic(topic: ProductTopic): string {
  if (topic.kind === 'draft')
    return `draft:${encodeURIComponent(productIdSchema.parse(topic.draftId))}`
  if (topic.kind === 'conversation' || topic.kind === 'conversationWindow' || topic.kind === 'conversationTurns' || topic.kind === 'questions')
    return `${topic.kind}:${encodeURIComponent(productIdSchema.parse(topic.conversationId))}:${encodeURIComponent(productIdSchema.parse(topic.branchId))}`
  return topic.kind
}
export function parseProductTopic(value: string): ProductTopic {
  const parts = value.split(':')
  let topic: ProductTopic
  if (parts.length === 1 && ['taskIndex', 'draftIndex', 'approvalInbox', 'serviceState'].includes(value))
    topic = { kind: value as 'taskIndex' | 'draftIndex' | 'approvalInbox' | 'serviceState' }
  else if (parts.length === 2 && parts[0] === 'draft')
    topic = { kind: 'draft', draftId: productIdSchema.parse(decodeURIComponent(parts[1]!)) }
  else if (parts.length === 3 && (parts[0] === 'conversation' || parts[0] === 'conversationWindow' || parts[0] === 'conversationTurns' || parts[0] === 'questions'))
    topic = { kind: parts[0], conversationId: productIdSchema.parse(decodeURIComponent(parts[1]!)), branchId: productIdSchema.parse(decodeURIComponent(parts[2]!)) }
  else
    throw new Error('Unknown product topic')
  if (formatProductTopic(topic) !== value)
    throw new Error('Noncanonical product topic')
  return topic
}
