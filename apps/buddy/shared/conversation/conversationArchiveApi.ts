import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, nullableTimestampSchema, optionalCursorSchema, timestampSchema, validationRequestSchemas } from '../runtime/apiValidation'

export const conversationArchiveItemSchema = z.object({
  id: idSchema,
  title: z.string().nullable(),
  spaceId: z.string().nullable(),
  archivedAt: nullableTimestampSchema,
  deletedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  metadataRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletionStatus: z.enum(['pending', 'failed']).nullable(),
  errorCode: z.string().nullable(),
}).strict()

export const conversationArchivePageSchema = z.object({
  items: z.array(conversationArchiveItemSchema),
  nextCursor: z.string().nullable(),
}).strict()

export const conversationArchiveQuerySchema = z.object({
  kind: z.enum(['archived', 'removed', 'deleting', 'managed']),
  spaceId: idSchema.nullable().optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: optionalCursorSchema,
}).strict()

export const conversationArchivePolicySchema = z.object({ days: z.union([z.literal(0), z.literal(3), z.literal(7), z.literal(30)]) }).strict()
export const conversationArchiveTargetSchema = z.object({
  conversationId: idSchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export type ConversationArchiveTarget = DeepReadonly<z.infer<typeof conversationArchiveTargetSchema>>
export type ConversationArchiveItem = DeepReadonly<z.infer<typeof conversationArchiveItemSchema>>
export type ConversationArchivePage = DeepReadonly<z.infer<typeof conversationArchivePageSchema>>
export type ConversationArchiveQuery = DeepReadonly<z.infer<typeof conversationArchiveQuerySchema>>
export type ConversationArchivePolicy = DeepReadonly<z.infer<typeof conversationArchivePolicySchema>>

export const conversationArchiveRpc = {
  deletePermanently: { method: 'conversations.deletePermanently', input: conversationArchiveTargetSchema, response: z.boolean() },
  archive: { method: 'conversations.archive', input: conversationArchiveTargetSchema, response: z.boolean() },
  restoreArchive: { method: 'conversations.restoreArchive', input: conversationArchiveTargetSchema, response: z.boolean() },
  deleteArchived: { method: 'conversations.deleteArchived', input: conversationArchiveTargetSchema, response: z.boolean() },
  listArchived: { method: 'conversations.listArchived', input: conversationArchiveQuerySchema, response: conversationArchivePageSchema },
  getArchivePolicy: { method: 'conversations.getArchivePolicy', input: validationRequestSchemas.empty, response: conversationArchivePolicySchema },
  setArchivePolicy: { method: 'conversations.setArchivePolicy', input: conversationArchivePolicySchema, response: conversationArchivePolicySchema },
} as const satisfies Record<string, RuntimeRequestContract>
