import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { QUIT_PREPARATION_TIMEOUT_MS } from '../../shared/lifecycle/closePreparation'
import { DESKTOP_IPC_CHANNELS } from '../shared/desktopApi'

export type DraftSaveFailureDecision = 'cancel' | 'discard' | 'retry'

export async function confirmDraftFlushBeforeQuit(
  flush: () => Promise<boolean>,
  resolveFailure: () => Promise<DraftSaveFailureDecision>,
): Promise<boolean> {
  while (!(await flush())) {
    const decision = await resolveFailure()
    if (decision === 'retry')
      continue
    return decision === 'discard'
  }
  return true
}

export async function requestRendererDraftFlush(
  window: BrowserWindow | null,
  ipc: Pick<IpcMain, 'off' | 'on'>,
  timeoutMs = QUIT_PREPARATION_TIMEOUT_MS,
): Promise<boolean> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed())
    return true
  const requestId = randomUUID()
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    let onAck = (_event: IpcMainEvent, _input: unknown) => undefined
    const finish = (saved: boolean) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      ipc.off(DESKTOP_IPC_CHANNELS.appPrepareQuitAck, onAck)
      resolve(saved)
    }
    onAck = (event: IpcMainEvent, input: unknown) => {
      if (event.sender !== window.webContents || !input || typeof input !== 'object')
        return
      const payload = input as { requestId?: unknown, saved?: unknown }
      if (payload.requestId !== requestId)
        return
      finish(payload.saved === true)
    }
    timeout = setTimeout(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(DESKTOP_IPC_CHANNELS.appCancelQuitPreparation, { requestId })
      finish(false)
    }, timeoutMs)
    ipc.on(DESKTOP_IPC_CHANNELS.appPrepareQuitAck, onAck)
    window.webContents.send(DESKTOP_IPC_CHANNELS.appPrepareQuit, { requestId })
  })
}
