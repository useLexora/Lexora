import type { FileIconThemeApi } from '../../shared/icons/fileIconThemeApi'
import { ipcRenderer } from 'electron'
import { FILE_ICON_IPC } from '../../shared/icons/fileIconThemeApi'
import { subscribe } from './subscribe'

export function createFileIconApi(): FileIconThemeApi {
  return Object.freeze<FileIconThemeApi>({
    initial: ipcRenderer.sendSync(FILE_ICON_IPC.initial),
    request: input => ipcRenderer.invoke(FILE_ICON_IPC.request, input),
    onDidChange: listener => subscribe(FILE_ICON_IPC.changed, listener),
  })
}
