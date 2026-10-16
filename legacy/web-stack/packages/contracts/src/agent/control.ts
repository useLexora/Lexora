import { z } from 'zod'

export const AGENT_RUNTIME_CONTROL_TYPE = {
  CANCEL_RUN: 'run.cancel',
  DELETE_CHECKPOINT_THREAD: 'checkpoint.thread.delete',
} as const

export const AGENT_RUNTIME_CONTROL_TYPE_VALUES = [
  AGENT_RUNTIME_CONTROL_TYPE.CANCEL_RUN,
  AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD,
] as const

export const AGENT_RUNTIME_CONTROL_RESULT_TYPE = {
  CHECKPOINT_THREAD_DELETE_COMPLETED: 'checkpoint.thread.delete.completed',
  CHECKPOINT_THREAD_DELETE_FAILED: 'checkpoint.thread.delete.failed',
} as const

export const AGENT_RUNTIME_CONTROL_RESULT_TYPE_VALUES = [
  AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_COMPLETED,
  AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_FAILED,
] as const

export const AgentRuntimeControlTypeSchema = z.enum(AGENT_RUNTIME_CONTROL_TYPE_VALUES)
export const AgentRuntimeControlResultTypeSchema = z.enum(AGENT_RUNTIME_CONTROL_RESULT_TYPE_VALUES)

const NonEmptyStringSchema = z.string().trim().min(1)

const AgentRuntimeCancelControlCommandSchema = z.object({
  controlId: NonEmptyStringSchema,
  type: z.literal(AGENT_RUNTIME_CONTROL_TYPE.CANCEL_RUN),
  runId: NonEmptyStringSchema,
  reason: z.string().trim().min(1).optional(),
}).strict()

const AgentCheckpointThreadDeleteControlCommandSchema = z.object({
  controlId: NonEmptyStringSchema,
  type: z.literal(AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD),
  cleanupTaskId: NonEmptyStringSchema.optional(),
  threadId: NonEmptyStringSchema,
  reason: z.string().trim().min(1).optional(),
}).strict()

export const AgentRuntimeControlCommandSchema = z.discriminatedUnion('type', [
  AgentRuntimeCancelControlCommandSchema,
  AgentCheckpointThreadDeleteControlCommandSchema,
])

const AgentCheckpointThreadDeleteCompletedControlResultSchema = z.object({
  controlId: NonEmptyStringSchema,
  type: z.literal(AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_COMPLETED),
  cleanupTaskId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
}).strict()

const AgentCheckpointThreadDeleteFailedControlResultSchema = z.object({
  controlId: NonEmptyStringSchema,
  type: z.literal(AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_FAILED),
  cleanupTaskId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  errorMessage: z.string().trim().min(1),
}).strict()

export const AgentRuntimeControlResultSchema = z.discriminatedUnion('type', [
  AgentCheckpointThreadDeleteCompletedControlResultSchema,
  AgentCheckpointThreadDeleteFailedControlResultSchema,
])

export type AgentRuntimeControlCommand = z.infer<typeof AgentRuntimeControlCommandSchema>
export type AgentRuntimeControlResult = z.infer<typeof AgentRuntimeControlResultSchema>
export type AgentRuntimeControlType = z.infer<typeof AgentRuntimeControlTypeSchema>
export type AgentRuntimeControlResultType = z.infer<typeof AgentRuntimeControlResultTypeSchema>
