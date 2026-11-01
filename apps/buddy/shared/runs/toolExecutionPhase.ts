import { z } from 'zod'

export const toolExecutionPhaseSchema = z.enum(['authorizing', 'queued', 'resource', 'preparing', 'capturing', 'executing', 'approval', 'cleaning', 'finished'])
export type ToolExecutionPhase = z.infer<typeof toolExecutionPhaseSchema>
export const toolResourceBlockerSchema = z.object({
  runId: z.string().min(1).max(256),
  title: z.string().max(256).optional(),
  since: z.number().finite().nonnegative(),
  state: z.enum(['active', 'queued']),
}).strict()
export type ToolResourceBlocker = z.infer<typeof toolResourceBlockerSchema>
export const toolExecutionTimingSchema = z.object({
  phase: toolExecutionPhaseSchema,
  durations: z.partialRecord(toolExecutionPhaseSchema, z.number().finite().nonnegative()),
  executionBasis: z.enum(['tool', 'backend', 'dispatch']).optional(),
  waitingFor: toolResourceBlockerSchema.optional(),
  outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
}).strict()
export type ToolExecutionTiming = z.infer<typeof toolExecutionTimingSchema>
export interface ToolExecutionPhaseChange {
  toolCallId: string
  toolName: string
  phase: ToolExecutionPhase
  executionBasis?: ToolExecutionTiming['executionBasis']
  waitingFor?: ToolResourceBlocker
  outcome?: ToolExecutionTiming['outcome']
}
