import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { idSchema, nullableTimestampSchema, timestampSchema, validationRequestSchemas } from '../runtime/apiValidation'
import { extensionActionResultSchema, extensionActionTriggerSchema } from './extensionAgent'

export const extensionActionTimelineSchema = z.object({
  kind: z.literal('extension-action'),
  id: idSchema,
  conversationId: idSchema,
  branchId: idSchema,
  sourceMessageId: idSchema.nullable(),
  extensionId: z.string(),
  extensionName: z.string(),
  actionId: z.string(),
  title: z.string(),
  trigger: extensionActionTriggerSchema,
  status: z.enum(['running', 'completed', 'skipped', 'failed', 'cancelled', 'interrupted']),
  message: z.string().nullable(),
  createdAt: timestampSchema,
  completedAt: nullableTimestampSchema,
}).strict()
export type ExtensionActionTimelineItem = z.infer<typeof extensionActionTimelineSchema>

export const extensionTaskActionSchema = z.object({ extensionId: z.string(), actionId: z.string(), title: z.string() }).strict()
export const extensionActionRpc = {
  list: { method: 'extensions.actions.list', input: validationRequestSchemas.empty, response: z.array(extensionTaskActionSchema) },
  invoke: { method: 'extensions.actions.invoke', input: z.object({ conversationId: idSchema, extensionId: z.string().max(120), actionId: z.string().max(180) }).strict(), response: extensionActionResultSchema },
} as const satisfies Record<string, RuntimeRequestContract>

export type ExtensionTaskAction = z.infer<typeof extensionTaskActionSchema>
export type ExtensionTaskActionInput = z.infer<typeof extensionActionRpc.invoke.input>
export type ExtensionTaskActionResult = z.infer<typeof extensionActionResultSchema>
