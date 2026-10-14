import { z } from 'zod'
import { backupSelectionSchema } from '../storage/backupScope'

export const backupScheduleSchema = z.object({
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekly']),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekday: z.number().int().min(0).max(6),
  scopes: backupSelectionSchema,
  credentials: z.boolean(),
  localKeep: z.number().int().min(0).max(365),
  remoteKeep: z.number().int().min(0).max(365),
}).strict()
export const backupScheduleInputSchema = backupScheduleSchema.extend({ password: z.string().min(8).max(1024).optional() })
export type BackupSchedule = z.infer<typeof backupScheduleSchema>
export type BackupScheduleInput = z.infer<typeof backupScheduleInputSchema>
export interface BackupScheduleState {
  connectionId: string
  policy: BackupSchedule
  nextRunAt: string | null
  lastSuccessAt: string | null
  retryAt: string | null
  status: 'idle' | 'waiting' | 'running' | 'failed'
  error: string | null
  cleanupError: boolean
}

export function nextBackupTime(policy: BackupSchedule, after: Date): string | null {
  if (policy.frequency === 'manual')
    return null
  if (policy.frequency === 'hourly')
    return new Date(after.getTime() + 60 * 60 * 1000).toISOString()
  const [hours, minutes] = policy.time.split(':').map(Number)
  const next = new Date(after)
  next.setHours(hours!, minutes!, 0, 0)
  if (policy.frequency === 'weekly')
    next.setDate(next.getDate() + (policy.weekday - next.getDay() + 7) % 7)
  if (next <= after)
    next.setDate(next.getDate() + (policy.frequency === 'weekly' ? 7 : 1))
  return next.toISOString()
}
