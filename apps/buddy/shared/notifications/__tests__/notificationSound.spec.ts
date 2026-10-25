import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lexoraConfigPatchSchema } from '../../../electron/shared/desktopApiSchemas'
import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES, notificationSoundAssetSchema, notificationSoundImportResultSchema, notificationSoundPreferencesSchema, notificationSoundRequestSchema } from '../notificationSound'

const asset = { id: randomUUID(), name: 'Sound', mimeType: 'audio/wav', durationMs: 900 }

describe('notification sound contract', () => {
  it('defaults old preferences and validates references, unique identities and bounds', () => {
    expect(notificationSoundPreferencesSchema.parse({})).toEqual(DEFAULT_NOTIFICATION_SOUND_PREFERENCES)
    expect(notificationSoundPreferencesSchema.parse({ selected: asset.id, sounds: [asset] })).toMatchObject({ selected: asset.id, volume: 0.6 })
    for (const value of [{ volume: -0.1 }, { volume: 1.1 }, { selected: asset.id }, { sounds: [asset, asset] }])
      expect(notificationSoundPreferencesSchema.safeParse(value).success).toBe(false)
    for (const value of [{ ...asset, durationMs: 10_001 }, { ...asset, durationMs: 0 }, { ...asset, mimeType: 'audio/ogg' }, { ...asset, id: '../outside' }])
      expect(notificationSoundAssetSchema.safeParse(value).success).toBe(false)
  })

  it('allows partial preferences without granting settings arbitrary asset writes', () => {
    for (const notificationSound of [{ selected: 'bell' }, { volume: 0 }, { selected: asset.id, volume: 1 }])
      expect(lexoraConfigPatchSchema.parse({ desktop: { notificationSound } }).desktop?.notificationSound).toEqual(notificationSound)
    expect(lexoraConfigPatchSchema.safeParse({ desktop: { notificationSound: { sounds: [asset] } } }).success).toBe(false)
  })

  it('accepts only structured actions and rejects arbitrary paths or builtin deletion', () => {
    for (const request of [{ action: 'import' }, { action: 'remove', id: asset.id }, { action: 'preview', id: 'drop' }, { action: 'stopPreview' }])
      expect(notificationSoundRequestSchema.parse(request)).toEqual(request)
    for (const request of [{ action: 'import', path: 'outside.wav' }, { action: 'remove', id: 'bell' }, { action: 'preview', id: '../outside' }])
      expect(notificationSoundRequestSchema.safeParse(request).success).toBe(false)
  })

  it('keeps import cancellation distinct from bounded failure reasons', () => {
    for (const result of [{ status: 'imported', id: asset.id }, { status: 'cancelled' }, { status: 'failed', reason: 'duration' }])
      expect(notificationSoundImportResultSchema.parse(result)).toEqual(result)
    expect(notificationSoundImportResultSchema.safeParse({ status: 'failed', reason: 'private path' }).success).toBe(false)
  })
})
