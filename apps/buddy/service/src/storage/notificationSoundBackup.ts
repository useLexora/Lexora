import type { NotificationSoundAsset } from '../../../shared/notifications/notificationSound'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { readNotificationSoundFile, removeNotificationSoundFile, writeNotificationSoundFile } from '../../../platform/storage/notificationSoundFiles'
import { isMissing } from '../../../platform/storage/storageFiles'
import { notificationSoundAssetIdSchema } from '../../../shared/notifications/notificationSound'
import { notificationSoundSettings } from './backupSettings'

export async function prepareNotificationSoundBackup(home: string, settings: string, signal: AbortSignal): Promise<void> {
  const preferences = notificationSoundSettings(settings)
  const ids = new Set(preferences?.sounds.map(sound => sound.id))
  for (const id of ids) {
    signal.throwIfAborted()
    await readNotificationSoundFile(home, id)
  }
  const entries = await readdir(join(home, 'notification-sounds')).catch((error) => {
    if (isMissing(error))
      return []
    throw error
  })
  for (const entry of entries) {
    signal.throwIfAborted()
    const id = notificationSoundAssetIdSchema.parse(entry.replace(/\.audio$/, ''))
    if (!ids.has(id))
      await removeNotificationSoundFile(home, id)
  }
}

export async function restoreNotificationSoundBackup(incomingHome: string, candidateHome: string, currentSettings: string, incomingSettings: string, signal: AbortSignal): Promise<string> {
  const incoming = notificationSoundSettings(incomingSettings)
  if (!incoming)
    return incomingSettings
  const current = notificationSoundSettings(currentSettings)
  const currentAssets = new Map(current?.sounds.map(sound => [sound.id, sound]))
  const imported: NotificationSoundAsset[] = []
  const reservedIds = new Set(incoming.sounds.map(sound => sound.id))
  let selected = incoming.selected
  for (const sound of incoming.sounds) {
    signal.throwIfAborted()
    const bytes = await readNotificationSoundFile(incomingHome, sound.id)
    const existing = await readOptional(candidateHome, sound.id)
    const metadata = currentAssets.get(sound.id)
    let id = sound.id
    if ((existing && !equalBytes(existing, bytes)) || (metadata && !equalMetadata(metadata, sound))) {
      let matching: NotificationSoundAsset | undefined
      for (const asset of currentAssets.values()) {
        signal.throwIfAborted()
        if (reservedIds.has(asset.id) || !equalMetadata(asset, sound))
          continue
        const content = await readOptional(candidateHome, asset.id)
        if (content && equalBytes(content, bytes)) {
          matching = asset
          break
        }
      }
      id = matching?.id ?? randomUUID()
      if (!matching)
        await writeNotificationSoundFile(candidateHome, id, bytes)
    }
    else if (!existing) {
      await writeNotificationSoundFile(candidateHome, id, bytes)
    }
    reservedIds.add(id)
    imported.push({ ...sound, id })
    if (incoming.selected === sound.id)
      selected = id
  }
  const settings = parse(incomingSettings)
  const desktop = settings.desktop as Record<string, unknown>
  desktop.notification_sound = { ...incoming, selected, sounds: imported }
  return stringify(settings)
}

async function readOptional(home: string, id: string): Promise<Uint8Array | null> {
  return readNotificationSoundFile(home, id).catch((error) => {
    if (isMissing(error))
      return null
    throw error
  })
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
function equalMetadata(left: NotificationSoundAsset, right: NotificationSoundAsset): boolean {
  return left.name === right.name && left.mimeType === right.mimeType && left.durationMs === right.durationMs
}
