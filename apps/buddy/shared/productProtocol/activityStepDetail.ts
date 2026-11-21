import { z } from 'zod'
import { productIdSchema } from './scalars'
import { productActivityStepSchema } from './turns'

const revision = z.string().regex(/^[0-9a-f]{64}$/)
export const STEP_DETAIL_TEXT_LIMIT = 12 * 1024
export const productReadActivityStepDetailInputSchema = z.object({
  conversationId: productIdSchema,
  branchId: productIdSchema,
  runId: productIdSchema,
  groupId: productIdSchema,
  stepId: productIdSchema,
  knownRevision: revision.optional(),
}).strict()
export const productReadActivityStepDetailResultSchema = z.object({
  stepId: productIdSchema,
  status: productActivityStepSchema.shape.status,
  messageId: productIdSchema.nullable(),
  revision,
  available: z.boolean(),
  truncated: z.boolean(),
  text: z.string().max(STEP_DETAIL_TEXT_LIMIT).nullable(),
}).strict()
export type ProductReadActivityStepDetailInput = z.infer<typeof productReadActivityStepDetailInputSchema>
