import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema } from '../runtime/apiValidation'
import { conversationSummarySchema } from './conversationApi'
import { taskMarkStateSchema } from './taskMarkApi'

export const CONVERSATION_HISTORY_PAGE_LIMIT = 100
export const CONVERSATION_HISTORY_LOOKUP_LIMIT = 500

export const conversationHistoryQuerySchema = z.object({
  kind: z.enum(['ordinary', 'attention', 'search']),
  spaceId: idSchema.nullable().optional(),
  query: z.string().trim().max(512).optional(),
  excludeIds: z.array(idSchema).max(CONVERSATION_HISTORY_LOOKUP_LIMIT).optional(),
  cursor: z.string().regex(/^[\w-]+$/).max(2_048).optional(),
  limit: z.number().int().min(1).max(CONVERSATION_HISTORY_PAGE_LIMIT).optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === 'ordinary' && input.spaceId === undefined)
    context.addIssue({ code: 'custom', path: ['spaceId'], message: 'Ordinary history requires an explicit space.' })
  if (input.kind === 'search' && !input.query)
    context.addIssue({ code: 'custom', path: ['query'], message: 'Search requires a nonempty query.' })
  if (input.kind !== 'search' && input.query !== undefined)
    context.addIssue({ code: 'custom', path: ['query'], message: 'Only search accepts a query.' })
  if (input.kind === 'search' && input.spaceId !== undefined)
    context.addIssue({ code: 'custom', path: ['spaceId'], message: 'Search covers all spaces.' })
  if (input.kind !== 'ordinary' && input.excludeIds !== undefined)
    context.addIssue({ code: 'custom', path: ['excludeIds'], message: 'Only ordinary history accepts exclusions.' })
})

export const conversationHistoryItemSchema = z.object({
  conversation: conversationSummarySchema,
  markState: taskMarkStateSchema,
}).strict()

export const conversationHistoryPageSchema = z.object({
  items: z.array(conversationHistoryItemSchema).max(CONVERSATION_HISTORY_PAGE_LIMIT),
  nextCursor: z.string().regex(/^[\w-]+$/).max(2_048).nullable(),
}).strict()

export const conversationHistoryEntriesSchema = z.object({
  ids: z.array(idSchema).max(CONVERSATION_HISTORY_LOOKUP_LIMIT),
}).strict()

export type ConversationHistoryQuery = DeepReadonly<z.infer<typeof conversationHistoryQuerySchema>>
export type LocalConversationHistoryItem = DeepReadonly<z.infer<typeof conversationHistoryItemSchema>>
export type LocalConversationHistoryPage = DeepReadonly<z.infer<typeof conversationHistoryPageSchema>>

export const conversationHistoryRpc = {
  listHistory: { method: 'conversations.listHistory', input: conversationHistoryQuerySchema, response: conversationHistoryPageSchema },
  getHistoryEntries: { method: 'conversations.getHistoryEntries', input: conversationHistoryEntriesSchema, response: z.array(conversationHistoryItemSchema).max(CONVERSATION_HISTORY_LOOKUP_LIMIT) },
} as const satisfies Record<string, RuntimeRequestContract>
