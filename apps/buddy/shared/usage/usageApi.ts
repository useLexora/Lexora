import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, timestampSchema, validationRequestSchemas } from '../runtime/apiValidation'

export const usageRecordSchema = z.object({
  cacheReadCost: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteCost: z.number().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  id: idSchema,
  inputCost: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  modelId: idSchema,
  outputCost: z.number().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  providerId: idSchema,
  purpose: z.string().min(1),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  runId: idSchema.nullable(),
  invocationId: idSchema.nullable().optional(),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict()

export const usageTotalsSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict()

export const usageSnapshotSchema = z.object({
  records: z.array(usageRecordSchema),
  totals: usageTotalsSchema,
}).strict()

export type LocalUsageSnapshot = DeepReadonly<z.infer<typeof usageSnapshotSchema>>

export const usageResponseSchemas = {
  usageSnapshot: usageSnapshotSchema,
} as const

export const usageRpc = {
  snapshot: { method: 'usage.snapshot', input: validationRequestSchemas.empty, response: usageResponseSchemas.usageSnapshot },
} as const satisfies Record<string, RuntimeRequestContract>
