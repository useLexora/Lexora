import { z } from 'zod'
import { PRODUCT_LIMITS } from './limits'
import { productTextRangeSchema } from './messageText'
import { productIdSchema as id } from './scalars'
import { productMessageSchema, productRunSchema } from './views'

const cursor = z.string().max(4096).nullable()
const count = z.number().int().nonnegative()
export const productTurnWindowInputSchema = z.object({ conversationId: id, branchId: id, cursor: cursor.default(null) }).strict()
export const productActivityGroupSchema = z.object({
  id,
  runId: id,
  afterMessageId: id.nullable(),
  createdAt: z.iso.datetime(),
  toolCount: count,
  reasoningCount: count,
  runningReasoningCount: count,
  interruptedReasoningCount: count,
  failedCount: count,
  runningCount: count,
  interruptedCount: count,
  activeToolName: z.string().max(256).nullable(),
  counts: z.array(z.object({ category: z.enum(['command', 'read', 'edit', 'create', 'other']), count }).strict()).max(5),
}).strict()
const legacyActivityStep = z.object({
  id,
  toolName: z.string().min(1).max(256),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  messageId: id.nullable(),
}).strict()
const summary = z.string().min(1).max(240)
export const productActivityStepSchema = legacyActivityStep.extend({ kind: z.literal('reasoning').optional(), summary: summary.optional() })
const orderedActivityStep = z.union([
  legacyActivityStep.extend({ summary: summary.optional() }),
  legacyActivityStep.extend({ kind: z.literal('reasoning'), toolName: z.literal('reasoning'), messageId: z.null() }),
])
export const productTurnMessageSchema = productMessageSchema.omit({ tool: true }).extend({
  role: z.enum(['user', 'assistant']),
  textRange: productTextRangeSchema.optional(),
  commentary: z.object({ text: z.string().max(2048), range: productTextRangeSchema }).strict().optional(),
  turnRootId: id.optional(),
  turnInputId: id.optional(),
})
export const productTurnWindowSchema = z.object({ items: z.array(productTurnMessageSchema).max(PRODUCT_LIMITS.topicItems), groups: z.array(productActivityGroupSchema).max(PRODUCT_LIMITS.topicItems), runs: z.array(productRunSchema).max(PRODUCT_LIMITS.topicItems), nextCursor: cursor }).strict()
export const productActivityStepsInputSchema = productTurnWindowInputSchema.extend({ runId: id, groupId: id, limit: z.number().int().min(1).max(PRODUCT_LIMITS.pageItems).default(32) })
export const productActivityStepsPageSchema = z.object({ items: z.array(legacyActivityStep).max(PRODUCT_LIMITS.pageItems), nextCursor: cursor }).strict()
export const productOrderedActivityStepsPageSchema = productActivityStepsPageSchema.extend({ items: z.array(orderedActivityStep).max(PRODUCT_LIMITS.pageItems) })
export type ProductActivityGroup = z.infer<typeof productActivityGroupSchema>
export type ProductActivityStep = z.infer<typeof productActivityStepSchema>
export type ProductTurnWindowPage = z.infer<typeof productTurnWindowSchema>
