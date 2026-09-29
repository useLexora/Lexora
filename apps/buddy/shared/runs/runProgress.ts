import { z } from 'zod'

export const buddyRunRetrySchema = z.object({
  attempt: z.number().int().positive(),
  maxAttempts: z.union([z.number().int().positive(), z.literal('unlimited')]),
  retryAt: z.iso.datetime().nullable(),
}).strict()

export type BuddyRunRetry = z.infer<typeof buddyRunRetrySchema>

export const buddyRunProgressSchema = z.object({
  phase: z.enum([
    'idle',
    'model_requesting',
    'model_streaming',
    'model_thinking',
    'model_responding',
    'preparing',
    'awaiting_approval',
    'tool_executing',
  ]),
  toolName: z.string().min(1).max(256).nullable(),
  retry: buddyRunRetrySchema.optional(),
}).strict()

export type BuddyRunProgress = z.infer<typeof buddyRunProgressSchema>
