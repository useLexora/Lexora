import type { BackupOptions } from '../storage/backupScope'
import type { BackupScheduleState } from './backupSchedule'
import { z } from 'zod'
import { backupRequestSchema } from '../storage/backupScope'

export const SYNC_CHANNEL = 'lexora:sync'
export const SYNC_CHANGED = 'lexora:sync:changed'
const connectionBase = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  endpoint: z.url().max(4096).refine((value) => {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search
  }),
}).strict()
export const remoteDirectorySchema = z.string().trim().max(1024).refine(value => !value.includes('\\') && !Array.from(value).some(character => character.charCodeAt(0) < 32) && !value.split('/').some(part => part === '.' || part === '..')).transform(value => value.replace(/^\/+|\/+$/g, ''))
export const webDavConnectionSchema = connectionBase.extend({ adapter: z.literal('webdav'), username: z.string().max(512), directory: remoteDirectorySchema.optional() })
export const s3ConnectionSchema = connectionBase.extend({
  adapter: z.literal('s3'),
  bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  region: z.string().trim().min(1).max(128).regex(/^[a-z0-9-]+$/i),
  prefix: remoteDirectorySchema,
  accessKeyId: z.string().trim().min(1).max(512),
  pathStyle: z.boolean(),
})
export const syncConnectionSchema = z.discriminatedUnion('adapter', [webDavConnectionSchema, s3ConnectionSchema])
const inputFields = { id: z.uuid().optional(), password: z.string().max(4096).optional() }
export const syncConnectionInputSchema = z.discriminatedUnion('adapter', [webDavConnectionSchema.omit({ id: true }).extend(inputFields), s3ConnectionSchema.omit({ id: true }).extend(inputFields)])
export type SyncConnection = z.infer<typeof syncConnectionSchema>
export type SyncConnectionInput = z.infer<typeof syncConnectionInputSchema>
const backupConfigurationSchema = z.object({ connection: syncConnectionInputSchema, frequency: z.enum(['hourly', 'daily', 'weekly']) }).strict()
export type BackupConfiguration = z.infer<typeof backupConfigurationSchema>
export interface SyncActivity {
  connectionId: string
  action: 'test' | 'list' | 'upload' | 'download' | 'prune'
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  completedBytes: number
  totalBytes: number | null
  error: string | null
}
export interface SyncState {
  selectedAdapter: SyncConnection['adapter']
  activeConnectionId: string | null
  schedules: BackupScheduleState[]
  scheduleError: boolean
  enabled: boolean
  connections: SyncConnection[]
  activity: SyncActivity | null
}
export const syncCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('selectAdapter'), adapter: z.enum(['webdav', 's3']) }).strict(),
  z.object({ action: z.literal('frequency'), frequency: z.enum(['hourly', 'daily', 'weekly']) }).strict(),
  z.object({ action: z.literal('backupNow'), options: backupRequestSchema, configuration: backupConfigurationSchema.optional() }).strict(),
  z.object({ action: z.literal('credential'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('setEnabled'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('testConnection'), connection: syncConnectionInputSchema }).strict(),
])
export interface SyncApi {
  selectAdapter: (adapter: SyncConnection['adapter']) => Promise<SyncState>
  setFrequency: (frequency: 'hourly' | 'daily' | 'weekly') => Promise<SyncState>
  backupNow: (options: BackupOptions, configuration?: BackupConfiguration) => Promise<SyncState>
  testConnection: (connection: SyncConnectionInput) => Promise<void>
  credential: (id: string) => Promise<string>
  state: () => Promise<SyncState>
  setEnabled: (enabled: boolean) => Promise<SyncState>
  onChanged: (listener: (state: SyncState) => void) => () => void
}
