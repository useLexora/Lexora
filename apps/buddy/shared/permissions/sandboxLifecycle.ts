import { z } from 'zod'
import { sandboxResultSchema } from './shellSandbox'

export const sandboxProcessStateSchema = z.object({
  pid: z.number().int().positive().optional(),
  exitCode: z.number().int().nullable().optional(),
  phase: z.enum(['spawned', 'exited', 'closed', 'cleanup_requested', 'resources_released', 'cleanup_failed']),
}).strict()
export type SandboxProcessState = z.infer<typeof sandboxProcessStateSchema>

export const sandboxLifecycleSnapshotSchema = z.object({
  phase: z.enum(['preparing', 'running', 'finished']),
  started: z.boolean(),
  waiting: z.number().int().nonnegative().max(1024),
  cancellation: z.enum(['none', 'requested', 'timed-out']),
  result: sandboxResultSchema.optional(),
  process: sandboxProcessStateSchema.optional(),
}).strict()
export type SandboxLifecycleSnapshot = z.infer<typeof sandboxLifecycleSnapshotSchema>

export const sandboxLifecycleEventSchema = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(['preparing', 'started', 'approval-wait', 'approval-settled', 'approval-resumed', 'cancel-requested', 'timed-out', 'settled', 'released', 'process']),
  snapshot: sandboxLifecycleSnapshotSchema,
}).strict()
export type SandboxLifecycleEvent = z.infer<typeof sandboxLifecycleEventSchema>

export const sandboxLifecycleNotificationSchema = sandboxLifecycleEventSchema.extend({ requestId: z.uuid() })
