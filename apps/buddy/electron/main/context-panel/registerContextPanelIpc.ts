import type { BrowserWindow } from 'electron'
import type { ContextPanelHost } from './ContextPanelHost'
import { ipcMain } from 'electron'
import { contextPanelCommandSchema } from '../../../shared/context-panel/contextPanel'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export function registerContextPanelIpc(host: ContextPanelHost, getWindow: () => BrowserWindow | null): () => void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.contextPanelGetState, (event) => {
    assertTrustedSender(event, getWindow())
    return host.getState()
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.contextPanelExecute, (event, command: unknown) => {
    assertTrustedSender(event, getWindow())
    return host.execute(contextPanelCommandSchema.parse(command))
  })
  const stop = host.subscribe((state) => {
    const window = getWindow()
    if (window && !window.isDestroyed())
      window.webContents.send(DESKTOP_IPC_CHANNELS.contextPanelStateChanged, state)
  })
  return () => {
    stop()
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.contextPanelGetState)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.contextPanelExecute)
  }
}
