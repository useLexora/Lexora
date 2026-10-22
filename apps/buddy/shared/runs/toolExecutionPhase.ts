import { z } from 'zod'

export const toolExecutionPhaseSchema = z.enum(['authorizing', 'resource', 'preparing', 'capturing', 'executing', 'approval', 'cleaning', 'finished'])
export type ToolExecutionPhase = z.infer<typeof toolExecutionPhaseSchema>
export const toolExecutionTimingSchema = z.object({
  phase: toolExecutionPhaseSchema,
  durations: z.partialRecord(toolExecutionPhaseSchema, z.number().finite().nonnegative()),
  executionBasis: z.enum(['tool', 'backend', 'dispatch']).optional(),
}).strict()
export type ToolExecutionTiming = z.infer<typeof toolExecutionTimingSchema>
export interface ToolExecutionPhaseChange {
  toolCallId: string
  toolName: string
  phase: ToolExecutionPhase
  executionBasis?: ToolExecutionTiming['executionBasis']
}
