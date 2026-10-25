import type { BuiltinNotificationSoundId } from '../../../shared/notifications/notificationSound'
import { readFile } from 'node:fs/promises'
import ambient from './sounds/notification_ambient.wav?asset'
import drop from './sounds/notification_decorative-01.wav?asset'
import bell from './sounds/notification_simple-01.wav?asset'

const sounds: Record<BuiltinNotificationSoundId, string> = { bell, drop, ambient }

export function readBuiltinNotificationSound(id: BuiltinNotificationSoundId): Promise<Uint8Array> {
  return readFile(sounds[id])
}
