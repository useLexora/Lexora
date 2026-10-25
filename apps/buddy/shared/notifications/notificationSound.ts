import { z } from 'zod'

export const NOTIFICATION_SOUND_CHANNEL = 'lexora:notification-sounds'
export const NOTIFICATION_SOUND_MAX_BYTES = 5 * 1024 * 1024
export const NOTIFICATION_SOUND_MAX_DURATION_MS = 10_000
export const BUILTIN_NOTIFICATION_SOUNDS = [
  { id: 'bell', durationMs: 817 },
  { id: 'drop', durationMs: 1561 },
  { id: 'ambient', durationMs: 3159 },
] as const

export type BuiltinNotificationSoundId = typeof BUILTIN_NOTIFICATION_SOUNDS[number]['id']

export function isBuiltinNotificationSound(id: string): id is BuiltinNotificationSoundId {
  return BUILTIN_NOTIFICATION_SOUNDS.some(sound => sound.id === id)
}

export const notificationSoundAssetIdSchema = z.uuid().transform(id => id.toLowerCase())
export const notificationSoundIdSchema = z.union([z.enum(['system', ...BUILTIN_NOTIFICATION_SOUNDS.map(sound => sound.id)]), notificationSoundAssetIdSchema])
export const notificationSoundAssetSchema = z.object({
  id: notificationSoundAssetIdSchema,
  name: z.string().trim().min(1).max(255),
  mimeType: z.enum(['audio/mpeg', 'audio/wav']),
  durationMs: z.number().finite().positive().max(NOTIFICATION_SOUND_MAX_DURATION_MS),
}).strict()
export type NotificationSoundAsset = z.infer<typeof notificationSoundAssetSchema>

export const notificationSoundPreferencesPatchSchema = z.object({
  selected: notificationSoundIdSchema.optional(),
  volume: z.number().finite().min(0).max(1).optional(),
}).strict()
export const notificationSoundPreferencesSchema = z.object({
  selected: notificationSoundIdSchema.default('system'),
  volume: z.number().finite().min(0).max(1).default(0.6),
  sounds: z.array(notificationSoundAssetSchema).default([]),
}).strict().refine(value => new Set(value.sounds.map(sound => sound.id)).size === value.sounds.length, 'Duplicate notification sound').refine(value => (value.selected === 'system' || isBuiltinNotificationSound(value.selected)) || value.sounds.some(sound => sound.id === value.selected), 'Unknown notification sound')
export type NotificationSoundPreferences = z.infer<typeof notificationSoundPreferencesSchema>
export const DEFAULT_NOTIFICATION_SOUND_PREFERENCES: NotificationSoundPreferences = { selected: 'system', volume: 0.6, sounds: [] }

export const notificationSoundRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import') }).strict(),
  z.object({ action: z.literal('remove'), id: notificationSoundAssetIdSchema }).strict(),
  z.object({ action: z.literal('preview'), id: notificationSoundIdSchema }).strict(),
  z.object({ action: z.literal('stopPreview') }).strict(),
])
export type NotificationSoundRequest = z.infer<typeof notificationSoundRequestSchema>
export const notificationSoundImportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('imported'), id: notificationSoundAssetIdSchema }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('failed'), reason: z.enum(['size', 'type', 'duration', 'read', 'save']) }).strict(),
])
export type NotificationSoundImportResult = z.infer<typeof notificationSoundImportResultSchema>
export const notificationSoundPreviewResultSchema = z.object({ durationMs: z.number().finite().min(0).max(NOTIFICATION_SOUND_MAX_DURATION_MS) }).strict()

export interface NotificationSoundsApi {
  import: () => Promise<NotificationSoundImportResult>
  remove: (id: string) => Promise<void>
  preview: (id: string) => Promise<{ durationMs: number }>
  stopPreview: () => Promise<void>
}
