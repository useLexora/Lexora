import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import type { z } from 'zod'
import type { desktopOpenIntentSchema } from '../../../shared/service/localServiceProtocol'
import type { DesktopStartup } from './DesktopStartup'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { desktopTargetAckSchema } from '../../../shared/service/localServiceProtocol'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'

export async function requestDesktopTarget(window: BrowserWindow, startup: DesktopStartup, intent: z.infer<typeof desktopOpenIntentSchema>, ipc: Pick<IpcMain, 'on' | 'off'> = ipcMain, options: { signal?: AbortSignal, available?: () => boolean } = {}): Promise<boolean> {
  const deadline = Date.now() + 20000
  const available = () => !options.signal?.aborted && (options.available?.() ?? true)
  if (!available())
    return false
  await new Promise<void>((resolve, reject) => {
    let stop = () => {}
    let timeout: ReturnType<typeof setTimeout>
    function close() {
      finish(new Error('DESKTOP_CLOSED'))
    }
    function finish(error?: Error) {
      clearTimeout(timeout)
      stop()
      window.off('closed', close)
      options.signal?.removeEventListener('abort', close)
      if (error)
        reject(error)
      else resolve()
    }
    timeout = setTimeout(() => finish(new Error('DESKTOP_RENDERER_NOT_READY')), 20000)
    const check = () => {
      const state = startup.state
      if (window.isDestroyed())
        close()
      else if (state.status === 'ready')
        finish()
      else if (state.status === 'failed' || state.status === 'stopped')
        finish(new Error('DESKTOP_RENDERER_NOT_READY'))
    }
    stop = startup.onStateChange(check)
    window.once('closed', close)
    options.signal?.addEventListener('abort', close, { once: true })
    check()
  })
  if (!available() || window.isDestroyed() || window.webContents.isDestroyed())
    return false
  const requestId = randomUUID()
  return new Promise<boolean>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>
    function finish(opened: boolean) {
      clearTimeout(timeout)
      ipc.off(DESKTOP_IPC_CHANNELS.appOpenTargetAck, receive)
      window.off('closed', close)
      options.signal?.removeEventListener('abort', close)
      resolve(opened)
    }
    function close() {
      finish(false)
    }
    function receive(event: IpcMainEvent, raw: unknown) {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return
      const result = desktopTargetAckSchema.safeParse(raw)
      if (result.success && result.data.requestId === requestId)
        finish(available() && result.data.opened)
    }
    timeout = setTimeout(finish, Math.max(0, deadline - Date.now()), false)
    ipc.on(DESKTOP_IPC_CHANNELS.appOpenTargetAck, receive)
    window.once('closed', close)
    options.signal?.addEventListener('abort', close, { once: true })
    try {
      window.webContents.send(DESKTOP_IPC_CHANNELS.appOpenTargetRequest, { requestId, intent })
    }
    catch {
      finish(false)
    }
  })
}
