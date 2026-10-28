import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, timestampSchema } from '../runtime/apiValidation'

export const EXECUTION_INPUT_RUN_BATCH_SIZE = 50
export const EXECUTION_INPUT_PAGE_SIZE = 100

export const executionInputSchema = z.object({
  kind: z.enum(['supplement', 'answer']),
  messageId: z.string(),
  text: z.string(),
  createdAt: timestampSchema,
  state: z.enum(['pending', 'accepted', 'consumed', 'undelivered']),
}).strict()

export const executionInputReceiptSchema = executionInputSchema.extend({
  conversationId: idSchema,
  branchId: idSchema,
  runId: idSchema,
  rootRunId: idSchema,
  buddyId: idSchema,
  buddyName: z.string().min(1).max(80),
  task: z.string().max(300),
}).strict()

export const executionInputsPageSchema = z.object({
  inputs: z.array(executionInputReceiptSchema).max(EXECUTION_INPUT_PAGE_SIZE),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict()

export type LocalExecutionInput = DeepReadonly<z.infer<typeof executionInputSchema>>
export type LocalExecutionInputReceipt = DeepReadonly<z.infer<typeof executionInputReceiptSchema>>
export type LocalExecutionInputsPage = DeepReadonly<z.infer<typeof executionInputsPageSchema>>
