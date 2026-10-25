import type { NotificationSoundAsset } from '../../../shared/notifications/notificationSound'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import { randomUUID } from 'node:crypto'
import { readNotificationSoundFile, removeNotificationSoundFile, writeNotificationSoundFile } from '../../../platform/storage/notificationSoundFiles'
import { NOTIFICATION_SOUND_MAX_BYTES, notificationSoundAssetIdSchema, notificationSoundAssetSchema } from '../../../shared/notifications/notificationSound'

export interface NotificationSoundLibraryOptions {
  home: string
  configStore: LexoraConfigStore
  applyConfig: (config: LexoraConfig) => Promise<void> | void
}

export class NotificationSoundLibrary {
  private readonly options: NotificationSoundLibraryOptions

  constructor(options: NotificationSoundLibraryOptions) {
    this.options = options
  }

  async add(bytes: Uint8Array, metadata: Omit<NotificationSoundAsset, 'id'>): Promise<NotificationSoundAsset> {
    if (bytes.byteLength <= 0 || bytes.byteLength > NOTIFICATION_SOUND_MAX_BYTES)
      throw new Error('NOTIFICATION_SOUND_SIZE')
    const asset = notificationSoundAssetSchema.parse({ ...metadata, id: randomUUID() })
    await writeNotificationSoundFile(this.options.home, asset.id, Uint8Array.from(bytes))
    try {
      await this.options.configStore.addNotificationSound(asset, this.options.applyConfig)
    }
    catch (error) {
      const current = await this.options.configStore.read().catch(() => null)
      if (current && !current.desktop.notificationSound.sounds.some(sound => sound.id === asset.id))
        await removeNotificationSoundFile(this.options.home, asset.id)
      throw error
    }
    return asset
  }

  async remove(id: string): Promise<void> {
    const assetId = notificationSoundAssetIdSchema.parse(id)
    await this.options.configStore.removeNotificationSound(assetId, this.options.applyConfig)
    await removeNotificationSoundFile(this.options.home, assetId)
  }

  async read(id: string): Promise<Uint8Array> {
    const assetId = notificationSoundAssetIdSchema.parse(id)
    const config = await this.options.configStore.read()
    if (!config.desktop.notificationSound.sounds.some(sound => sound.id === assetId))
      throw new Error('NOTIFICATION_SOUND_NOT_FOUND')
    return readNotificationSoundFile(this.options.home, assetId)
  }
}
