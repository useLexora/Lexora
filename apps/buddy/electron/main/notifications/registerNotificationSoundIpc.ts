import type { BrowserWindow, WebContentsDidStartNavigationEventParams } from 'electron'
import type { NotificationSoundImportResult } from '../../../shared/notifications/notificationSound'
import type { NotificationAudioPlayer } from './NotificationAudioPlayer'
import type { NotificationSoundLibrary } from './NotificationSoundLibrary'
import type { NotificationSoundService } from './NotificationSoundService'
import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import { NOTIFICATION_SOUND_CHANNEL, NOTIFICATION_SOUND_MAX_BYTES, notificationSoundRequestSchema } from '../../../shared/notifications/notificationSound'
import { assertTrustedSender } from '../ipc'
import { NotificationAudioError } from './NotificationAudioPlayer'

interface NotificationSoundIpcOptions {
  getWindow: () => BrowserWindow | null
  library: NotificationSoundLibrary
  sounds: NotificationSoundService
  player: NotificationAudioPlayer
}

export function registerNotificationSoundIpc(options: NotificationSoundIpcOptions): () => void {
  let importing = false
  let previewCleanup: (() => void) | undefined
  ipcMain.handle(NOTIFICATION_SOUND_CHANNEL, async (event, raw: unknown) => {
    const frame = event.senderFrame
    const guard = () => {
      assertTrustedSender(event, options.getWindow())
      if (!frame || frame.detached || frame !== event.sender.mainFrame)
        throw new Error('NOTIFICATION_SOUND_OWNER_EXPIRED')
    }
    guard()
    const request = notificationSoundRequestSchema.parse(raw)
    switch (request.action) {
      case 'preview': {
        previewCleanup?.()
        const contents = event.sender
        const window = options.getWindow()!
        let timer: ReturnType<typeof setTimeout> | undefined
        const cancel = () => {
          if (previewCleanup !== cleanup)
            return
          cleanup()
          void options.sounds.stopPreview().catch(() => {})
        }
        const navigate = (details: WebContentsDidStartNavigationEventParams) => {
          if (details.isMainFrame)
            cancel()
        }
        function cleanup() {
          clearTimeout(timer)
          contents.off('did-start-navigation', navigate)
          contents.off('render-process-gone', cancel)
          contents.off('destroyed', cancel)
          window.off('hide', cancel)
          if (previewCleanup === cleanup)
            previewCleanup = undefined
        }
        previewCleanup = cleanup
        contents.on('did-start-navigation', navigate)
        contents.on('render-process-gone', cancel)
        contents.on('destroyed', cancel)
        window.on('hide', cancel)
        const isCurrent = () => previewCleanup === cleanup && !contents.isDestroyed() && !frame?.detached && frame === contents.mainFrame && options.getWindow() === window
        try {
          const result = await options.sounds.preview(request.id, isCurrent)
          if (isCurrent())
            timer = setTimeout(cleanup, result.durationMs)
          return result
        }
        catch (error) {
          cleanup()
          throw error
        }
      }
      case 'stopPreview':
        previewCleanup?.()
        return options.sounds.stopPreview()
      case 'remove':
        previewCleanup?.()
        await options.sounds.stopPreview()
        guard()
        return options.library.remove(request.id)
      case 'import':
        if (importing)
          return { status: 'cancelled' } satisfies NotificationSoundImportResult
        importing = true
        try {
          const selected = await dialog.showOpenDialog(options.getWindow()!, {
            properties: ['openFile'],
            filters: [{ name: 'MP3 / WAV', extensions: ['mp3', 'wav'] }],
          })
          guard()
          if (selected.canceled || !selected.filePaths[0])
            return { status: 'cancelled' } satisfies NotificationSoundImportResult
          return await importSound(selected.filePaths[0], options, guard)
        }
        finally {
          importing = false
        }
    }
  })
  return () => {
    previewCleanup?.()
    ipcMain.removeHandler(NOTIFICATION_SOUND_CHANNEL)
  }
}

async function importSound(path: string, options: NotificationSoundIpcOptions, guard: () => void): Promise<NotificationSoundImportResult> {
  let bytes: Buffer
  try {
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile())
        return { status: 'failed', reason: 'type' }
      if (stat.size > NOTIFICATION_SOUND_MAX_BYTES)
        return { status: 'failed', reason: 'size' }
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead)
          break
        length += result.bytesRead
      }
      if (length !== stat.size)
        return { status: 'failed', reason: 'read' }
      bytes = buffer.subarray(0, length)
    }
    finally {
      await file.close()
    }
  }
  catch {
    return { status: 'failed', reason: 'read' }
  }
  const mimeType = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    ? 'audio/wav'
    : bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xFF && (bytes[1]! & 0xE0) === 0xE0)
      ? 'audio/mpeg'
      : null
  if (!mimeType)
    return { status: 'failed', reason: 'type' }
  let durationMs: number
  try {
    durationMs = await options.player.inspect(bytes, mimeType)
  }
  catch (error) {
    return { status: 'failed', reason: error instanceof NotificationAudioError ? error.reason : 'read' }
  }
  guard()
  try {
    const asset = await options.library.add(bytes, { name: basename(path).slice(0, 128), mimeType, durationMs })
    return { status: 'imported', id: asset.id }
  }
  catch {
    return { status: 'failed', reason: 'save' }
  }
}
