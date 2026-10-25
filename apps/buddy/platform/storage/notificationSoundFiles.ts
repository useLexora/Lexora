import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { NOTIFICATION_SOUND_MAX_BYTES, notificationSoundAssetIdSchema } from '../../shared/notifications/notificationSound'

export function notificationSoundPath(home: string, id: string): string {
  return join(home, 'notification-sounds', `${notificationSoundAssetIdSchema.parse(id)}.audio`)
}

async function soundDirectory(home: string, create = false): Promise<string> {
  const directory = join(home, 'notification-sounds')
  if (create)
    await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('NOTIFICATION_SOUND_INVALID_DIRECTORY')
  return directory
}

export async function readNotificationSoundFile(home: string, id: string): Promise<Uint8Array> {
  const path = notificationSoundPath(home, id)
  await soundDirectory(home)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('NOTIFICATION_SOUND_INVALID_FILE')
  if (before.size <= 0 || before.size > NOTIFICATION_SOUND_MAX_BYTES)
    throw new Error('NOTIFICATION_SOUND_SIZE')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
      throw new Error('NOTIFICATION_SOUND_CHANGED')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead)
        break
      length += bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(path)
    await soundDirectory(home)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev)
      throw new Error('NOTIFICATION_SOUND_CHANGED')
    return bytes.subarray(0, length)
  }
  finally {
    await handle.close()
  }
}

export async function writeNotificationSoundFile(home: string, id: string, bytes: Uint8Array): Promise<void> {
  const path = notificationSoundPath(home, id)
  if (bytes.byteLength <= 0 || bytes.byteLength > NOTIFICATION_SOUND_MAX_BYTES)
    throw new Error('NOTIFICATION_SOUND_SIZE')
  await soundDirectory(home, true)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  }
  catch (error) {
    await handle.close()
    await rm(path, { force: true })
    throw error
  }
  await handle.close()
}

export async function removeNotificationSoundFile(home: string, id: string): Promise<void> {
  const path = notificationSoundPath(home, id)
  try {
    await soundDirectory(home)
    await rm(path, { force: true })
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
}
