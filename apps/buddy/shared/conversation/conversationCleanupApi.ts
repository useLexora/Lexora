import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { conversationArchiveTargetSchema } from './conversationArchiveApi'

export const conversationCleanupScopeSchema = z.literal('legacy_removed')

export const conversationCleanupQuerySchema = z.object({
  scope: conversationCleanupScopeSchema,
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()

export const conversationCleanupDeleteSchema = conversationArchiveTargetSchema.extend({
  scope: conversationCleanupScopeSchema,
}).strict()

export const conversationCleanupItemSchema = z.object({
  conversationId: z.string().min(1).max(180),
  title: z.string().nullable(),
  removedAt: z.string(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  estimatedBytes: z.number().int().nonnegative().nullable(),
  canDelete: z.boolean(),
  blockedReason: z.string().nullable(),
}).strict()

export const conversationCleanupPageSchema = z.object({
  items: z.array(conversationCleanupItemSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict()

export const conversationCleanupResultSchema = z.object({
  status: z.enum(['deleted', 'pending', 'failed']),
  errorCode: z.string().optional(),
}).strict()

export type ConversationCleanupQuery = z.infer<typeof conversationCleanupQuerySchema>
export type ConversationCleanupDelete = z.infer<typeof conversationCleanupDeleteSchema>
export type ConversationCleanupItem = z.infer<typeof conversationCleanupItemSchema>
export type ConversationCleanupPage = z.infer<typeof conversationCleanupPageSchema>
export type ConversationCleanupResult = z.infer<typeof conversationCleanupResultSchema>

export interface ConversationCleanup {
  list: (input: ConversationCleanupQuery) => Promise<ConversationCleanupPage>
  delete: (input: ConversationCleanupDelete) => Promise<ConversationCleanupResult>
}

export const conversationCleanupRpc = {
  list: { method: 'conversations.cleanup.list', input: conversationCleanupQuerySchema, response: conversationCleanupPageSchema },
  delete: { method: 'conversations.cleanup.delete', input: conversationCleanupDeleteSchema, response: conversationCleanupResultSchema },
} as const satisfies Record<string, RuntimeRequestContract>
