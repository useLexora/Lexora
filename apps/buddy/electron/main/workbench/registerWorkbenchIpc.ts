import type { BrowserWindow } from 'electron'
import type { WorkbenchStateStore } from './WorkbenchStateStore'
import { ipcMain } from 'electron'
import { workbenchStateSchema } from '../../../shared/workbench/workbenchState'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export function registerWorkbenchIpc(store: WorkbenchStateStore, getWindow: () => BrowserWindow | null): () => void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.workbenchRead, (event) => {
    assertTrustedSender(event, getWindow())
    return store.read()
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.workbenchWrite, (event, input: unknown) => {
    assertTrustedSender(event, getWindow())
    return store.write(workbenchStateSchema.parse(input))
  })
  return () => {
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.workbenchRead)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.workbenchWrite)
  }
}
