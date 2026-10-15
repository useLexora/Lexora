import type { BackupOptions } from './backupScope'
import type { SnapshotCatalog, SnapshotSummary } from './snapshot'
import { z } from 'zod'
import { backupOptionsSchema, backupSelectionSchema } from './backupScope'

export const STORAGE_LAYOUT_VERSION = 1
export const STORAGE_CHANNEL = 'lexora:storage'
export const STORAGE_CHANGED = 'lexora:storage:changed'
export const storageOperationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['consolidate', 'relocate', 'restore']),
  source: z.string().min(1),
  target: z.string().min(1),
  phase: z.enum(['pending', 'copying', 'converting', 'verifying', 'ready', 'failed']),
  createdAt: z.string(),
  snapshotId: z.uuid().optional(),
  scopes: backupSelectionSchema.optional(),
  credentials: z.boolean().optional(),
  error: z.string().nullable(),
}).strict()
export const storageIdentitySchema = z.object({
  version: z.literal(1),
  dataId: z.uuid(),
  generation: z.uuid(),
  layoutVersion: z.literal(STORAGE_LAYOUT_VERSION),
}).strict()
export const storageHistorySchema = z.object({
  id: z.uuid(),
  kind: storageOperationSchema.shape.kind,
  source: z.string(),
  target: z.string(),
  completedAt: z.string(),
  retainedTarget: z.string().optional(),
}).strict()
export type StorageIdentity = z.infer<typeof storageIdentitySchema>
export type StorageOperation = z.infer<typeof storageOperationSchema>
export type StorageHistory = z.infer<typeof storageHistorySchema>
export interface StorageProgress {
  phase: 'preparing' | 'copying' | 'converting' | 'verifying' | 'activating' | 'completed' | 'failed' | 'cancelled'
  completedBytes: number
  totalBytes: number | null
  files: number
  error: string | null
  category?: 'browser' | 'preferences' | 'data'
}
export interface StorageSummary {
  root: string
  defaultRoot: string
  identity: StorageIdentity
  pending: StorageOperation | null
  history: StorageHistory[]
}
export interface StorageUsage {
  scannedAt: string
  categories: Array<{
    id: 'data' | 'device' | 'browser' | 'plugins' | 'skills' | 'cache' | 'browserCache' | 'logs' | 'recovery' | 'exports'
    bytes: number
    files: number
  }>
  missing: number
}
export const storageCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshots') }).strict(),
  z.object({ action: z.literal('delete'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('prune') }).strict(),
  z.object({ action: z.literal('snapshot'), options: backupOptionsSchema.optional() }).strict(),
  z.object({ action: z.literal('restore'), id: z.uuid(), options: backupOptionsSchema }).strict(),
  z.object({ action: z.literal('import') }).strict(),
  z.object({ action: z.literal('export'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('summary') }).strict(),
  z.object({ action: z.literal('usage') }).strict(),
  z.object({ action: z.literal('choose') }).strict(),
  z.object({ action: z.literal('open') }).strict(),
  z.object({ action: z.literal('relocate'), target: z.string().min(1).max(32768) }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('restart') }).strict(),
])
export interface StorageApi {
  prune: () => Promise<void>
  delete: (id: string) => Promise<void>
  snapshots: () => Promise<SnapshotCatalog>
  snapshot: (options?: BackupOptions) => Promise<SnapshotSummary>
  restore: (id: string, options: BackupOptions) => Promise<StorageSummary>
  import: () => Promise<SnapshotSummary | null>
  export: (id: string) => Promise<string | null>
  onProgress: (listener: (progress: StorageProgress | null) => void) => () => void
  summary: () => Promise<StorageSummary>
  usage: () => Promise<StorageUsage>
  choose: () => Promise<string | null>
  open: () => Promise<void>
  relocate: (target: string) => Promise<StorageSummary>
  cancel: () => Promise<StorageSummary>
  restart: () => Promise<void>
}
