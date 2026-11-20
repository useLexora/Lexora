import { z } from 'zod'

export const buddyRunIdSchema = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)

export const buddyRunEventSchema = z.object({
  runId: buddyRunIdSchema,
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
}).strict()

export interface BuddyRunEvent extends z.infer<typeof buddyRunEventSchema> {}

export interface AppendBuddyRunEventInput {
  runId: string
  type: string
  payload: unknown
  createdAt?: string
}

export interface ListBuddyRunEventsOptions {
  afterSequence?: number
  throughSequence?: number
  maxPayloadBytes?: number
  limit?: number
}

export function isTerminalRunEventType(type: string): boolean {
  return terminalRunStatus(type) !== null
}

export function terminalRunStatus(
  type: string,
): 'cancelled' | 'completed' | 'failed' | null {
  if (type === 'run.cancelled')
    return 'cancelled'
  if (type === 'run.completed')
    return 'completed'
  if (type === 'run.failed')
    return 'failed'
  return null
}
