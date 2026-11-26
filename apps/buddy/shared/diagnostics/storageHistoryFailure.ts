import { z } from 'zod'

export const storageHistoryIdentityFieldSchema = z.enum(['device', 'fileId', 'size', 'modifiedTime', 'changeTime', 'creationTime'])

export const storageHistoryFailureSchema = z.object({
  kind: z.literal('storage_history'),
  step: z.enum(['checkpoints', 'runs']),
  reason: z.enum(['journal_missing', 'checkpoint_missing', 'projection_version', 'checkpoint_watermark', 'identity_format', 'file_size', 'run_not_terminal', 'maintenance_pending', 'projection_mismatch', 'checkpoint_range']),
  identityChanges: z.array(storageHistoryIdentityFieldSchema).max(6).readonly(),
  runId: z.uuid().optional(),
  checkpointVersion: z.number().int().nonnegative().nullable(),
  checkpointLastSequence: z.number().int().nonnegative().nullable(),
  sourceEventCount: z.number().int().nonnegative(),
  projectedEventCount: z.number().int().nonnegative(),
  sourceLastSequence: z.number().int().nonnegative(),
  projectedLastSequence: z.number().int().nonnegative(),
  firstUnverifiedSequence: z.number().int().positive().optional(),
}).strict()

export type StorageHistoryFailure = z.infer<typeof storageHistoryFailureSchema>
