import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AgentClientActionSchema = z.object({
  type: NonEmptyStringSchema,
  resultType: NonEmptyStringSchema,
  toolCallId: NonEmptyStringSchema,
  skillKey: NonEmptyStringSchema.optional(),
  actionName: NonEmptyStringSchema,
  reason: NonEmptyStringSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const AgentClientActionResultSchema = z.object({
  type: NonEmptyStringSchema,
  toolCallId: NonEmptyStringSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema.optional(),
  }).strict().optional(),
}).strict()

export type AgentClientAction = z.infer<typeof AgentClientActionSchema>
export type AgentClientActionResult = z.infer<typeof AgentClientActionResultSchema>
