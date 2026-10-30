import type { RuntimeNotificationContract, RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema } from '../runtime/apiValidation.ts'
import { modelThroughputSchema } from './conversationStatusApi.ts'

export const taskMetricsRequestSchema = z.object({
  conversationId: idSchema,
  branchId: idSchema,
}).strict()

export const taskMetricsSchema = taskMetricsRequestSchema.extend({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  tokens: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
  }).strict(),
  throughput: modelThroughputSchema,
}).strict()

export const taskMetricsChangedSchema = z.object({
  conversationId: idSchema,
  revision: z.number().int().positive(),
}).strict()

export type TaskMetricsChanged = Readonly<z.infer<typeof taskMetricsChangedSchema>>

export const taskMetricsChanged = {
  method: 'metrics.changed',
  params: taskMetricsChangedSchema,
} as const satisfies RuntimeNotificationContract

export type TaskMetricsRequest = z.infer<typeof taskMetricsRequestSchema>
export type LocalTaskMetrics = DeepReadonly<z.infer<typeof taskMetricsSchema>>

export const runsMetricsRpc = {
  metrics: {
    method: 'runs.metrics',
    input: taskMetricsRequestSchema,
    response: taskMetricsSchema,
  },
} as const satisfies Record<string, RuntimeRequestContract>
