import type { NotificationSoundPreferences } from '../../../shared/notifications/notificationSound'
import type { NotificationAudioPlayer } from './NotificationAudioPlayer'
import type { NotificationSoundLibrary } from './NotificationSoundLibrary'
import { createBuiltinNotificationSound } from './builtinNotificationSounds'

export interface NotificationSoundServiceOptions {
  player: Pick<NotificationAudioPlayer, 'play' | 'stop' | 'dispose'>
  library: Pick<NotificationSoundLibrary, 'read'>
  getPreferences: () => NotificationSoundPreferences
  now?: () => number
}

export class NotificationSoundService {
  readonly #options: NotificationSoundServiceOptions
  #previewVersion = 0
  #notificationVersion = 0
  #notificationPending = false
  #lastNotificationAt = Number.NEGATIVE_INFINITY
  #disposed = false

  constructor(options: NotificationSoundServiceOptions) {
    this.#options = options
  }

  async preview(id: string, isEligible: () => boolean = () => true): Promise<{ durationMs: number }> {
    const version = ++this.#previewVersion
    await this.#options.player.stop('preview')
    const { bytes, mimeType } = await this.#resolve(id)
    const durationMs = await this.#options.player.play(bytes, mimeType, this.#options.getPreferences().volume, 'preview', () => !this.#disposed && version === this.#previewVersion && isEligible())
    return { durationMs }
  }

  async stopPreview(): Promise<void> {
    this.#previewVersion++
    await this.#options.player.stop('preview')
  }

  async playNotification(isEligible: () => boolean): Promise<void> {
    const { selected, volume } = this.#options.getPreferences()
    const now = this.#options.now ?? Date.now
    if (this.#disposed || this.#notificationPending || selected === 'system' || volume === 0 || !isEligible() || now() - this.#lastNotificationAt < 2500)
      return
    this.#notificationPending = true
    const version = this.#notificationVersion
    const isCurrent = () => !this.#disposed && version === this.#notificationVersion && isEligible()
      && this.#options.getPreferences().selected === selected
    try {
      const { bytes, mimeType } = await this.#resolve(selected)
      const durationMs = await this.#options.player.play(bytes, mimeType, volume, 'notification', isCurrent)
      if (durationMs > 0)
        this.#lastNotificationAt = now()
    }
    finally {
      this.#notificationPending = false
    }
  }

  async settingsChanged(): Promise<void> {
    this.#notificationVersion++
    this.#previewVersion++
    await this.#options.player.stop('all')
  }

  dispose(): void {
    this.#disposed = true
    this.#previewVersion++
    this.#notificationVersion++
    this.#options.player.dispose()
  }

  async #resolve(id: string): Promise<{ bytes: Uint8Array, mimeType: string }> {
    if (this.#disposed)
      throw new Error('NOTIFICATION_AUDIO_DISPOSED')
    if (id === 'bell' || id === 'drop')
      return { bytes: createBuiltinNotificationSound(id), mimeType: 'audio/wav' }
    const asset = this.#options.getPreferences().sounds.find(sound => sound.id === id)
    if (!asset)
      throw new Error('NOTIFICATION_AUDIO_NOT_FOUND')
    return { bytes: await this.#options.library.read(id), mimeType: asset.mimeType }
  }
}
