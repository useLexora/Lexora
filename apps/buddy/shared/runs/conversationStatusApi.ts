import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, validationRequestSchemas } from '../runtime/apiValidation'

const tallySchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
}).strict()

const namedCountSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict()

const tokenTotalsSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict()

export const cacheWarmingStatusSchema = z.enum(['off', 'unsupported', 'idle', 'waiting', 'scheduled', 'refreshing', 'uneconomic', 'unavailable', 'expired', 'stopped'])
export type LocalCacheWarmingStatus = z.infer<typeof cacheWarmingStatusSchema>

export const conversationStatusSchema = z.object({
  cacheWarming: cacheWarmingStatusSchema.nullable(),
  activity: z.object({
    turns: z.number().int().nonnegative(),
    runs: z.object({
      automation: tallySchema,
      chat: tallySchema,
      compaction: tallySchema,
    }).strict(),
    tools: z.object({
      denied: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      top: z.array(namedCountSchema),
      total: z.number().int().nonnegative(),
    }).strict(),
    compactions: z.object({
      count: z.number().int().nonnegative(),
      lastAfterTokens: z.number().int().nonnegative().nullable(),
      lastBeforeTokens: z.number().int().nonnegative().nullable(),
    }).strict(),
  }).strict(),
  timing: z.object({
    modelMs: z.number().nonnegative(),
    wallMs: z.number().nonnegative(),
    toolMs: z.number().nonnegative(),
    throughput: z.object({
      samples: z.number().int().nonnegative(),
      tokensPerSecond: z.number().nonnegative(),
    }).strict(),
    ttft: z.object({
      averageMs: z.number().nonnegative(),
      maxMs: z.number().nonnegative(),
      samples: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  tokens: z.object({
    byModel: z.array(tokenTotalsSchema.extend({
      modelId: idSchema,
      providerId: idSchema,
      runCount: z.number().int().nonnegative(),
    }).strict()),
    byPurpose: z.array(tokenTotalsSchema.extend({ purpose: z.string().min(1) }).strict()),
    totals: tokenTotalsSchema,
  }).strict(),
}).strict()

export type LocalConversationStatus = DeepReadonly<z.infer<typeof conversationStatusSchema>>

export const conversationStatusRequestSchema = z.object({
  conversationId: idSchema,
}).strict()

export const runsStatusRpc = {
  status: {
    method: 'runs.status',
    input: conversationStatusRequestSchema,
    response: conversationStatusSchema,
  },
} as const satisfies Record<string, RuntimeRequestContract>

export const emptyConversationStatusRequest = validationRequestSchemas.empty
