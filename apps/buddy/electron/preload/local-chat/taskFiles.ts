import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createTaskFilesApi(): Pick<LocalChatApi, 'taskFiles'> {
  return {
    taskFiles: Object.freeze({
      resolve: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskFilesResolve, { ...input }),
      read: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskFilesRead, { ...input }),
      revealFile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskFilesReveal, { ...input }),
    }),
  }
}
