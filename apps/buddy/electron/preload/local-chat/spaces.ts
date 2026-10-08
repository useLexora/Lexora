import type { SpaceChangeNotice } from '../../../shared/spaces/spaceApi'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createSpacesApi(): Pick<LocalChatApi, 'spaces'> {
  return {
    spaces: Object.freeze({
      onChanged: listener => subscribe<SpaceChangeNotice>(LOCAL_CHAT_IPC_CHANNELS.spacesChanged, listener),
      readDocument: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentRead, { ...input }),
      saveDocument: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentSave, { ...input }),
      mutateEntry: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceFilesMutate, { ...input }),
      locateEntry: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.spaceFilesLocate, { ...input }),
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
