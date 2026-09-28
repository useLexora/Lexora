import type { BrowserWindow } from 'electron'
import type { WorkbenchStateStore } from './WorkbenchStateStore'
import { ipcMain } from 'electron'
import { workbenchStateSchema, workbenchWriteOptionsSchema } from '../../../shared/workbench/workbenchState'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export function registerWorkbenchIpc(store: WorkbenchStateStore, getWindow: () => BrowserWindow | null): () => void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.workbenchRead, (event) => {
    assertTrustedSender(event, getWindow())
    return store.read()
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.workbenchWrite, (event, input: unknown, options: unknown) => {
    assertTrustedSender(event, getWindow())
    return store.write(workbenchStateSchema.parse(input), workbenchWriteOptionsSchema.parse(options ?? {}).resetRecovery)
  })
  return () => {
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.workbenchRead)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.workbenchWrite)
  }
}
