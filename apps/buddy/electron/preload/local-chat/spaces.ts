import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createSpacesApi(): Pick<LocalChatApi, 'spaces'> {
  return {
    spaces: Object.freeze({
      readDocument: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentRead, { ...input }),
      saveDocument: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentSave, { ...input }),
      listDirectory: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceFilesList, { ...input }),
      readFile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceFilesRead, { ...input }),
      revealFile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceFilesReveal, { ...input }),
      create: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesCreate, input),
      delete: spaceId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesDelete, { spaceId }),
      list: limit => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesList, { limit }),
      searchFiles: (spaceId, query) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesSearchFiles, { spaceId, query }),
      selectDirectory: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesSelectDirectory),
      update: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spacesUpdate, input),
    }),
  }
}
