import { z } from 'zod'
import { AgentClientActionResultSchema } from './client-action'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AGENT_GENERATION_COMMAND_KIND = {
  START: 'start',
  RESUME: 'resume',
} as const

export const AGENT_GENERATION_COMMAND_KIND_VALUES = [
  AGENT_GENERATION_COMMAND_KIND.START,
  AGENT_GENERATION_COMMAND_KIND.RESUME,
] as const

export const AgentGenerationCommandSchema = z.object({
  kind: z.enum(AGENT_GENERATION_COMMAND_KIND_VALUES).default(AGENT_GENERATION_COMMAND_KIND.START),
  generationId: NonEmptyStringSchema,
  commandId: NonEmptyStringSchema,
  idempotencyKey: NonEmptyStringSchema,
  attempt: z.number().int().nonnegative().default(0),
  resume: AgentClientActionResultSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === AGENT_GENERATION_COMMAND_KIND.RESUME && !value.resume) {
    ctx.addIssue({
      code: 'custom',
      path: ['resume'],
      message: 'resume command requires a resume payload',
    })
  }

  if (value.kind === AGENT_GENERATION_COMMAND_KIND.START && value.resume) {
    ctx.addIssue({
      code: 'custom',
      path: ['resume'],
      message: 'start command cannot include a resume payload',
    })
  }
})

export type AgentGenerationCommand = z.infer<typeof AgentGenerationCommandSchema>
