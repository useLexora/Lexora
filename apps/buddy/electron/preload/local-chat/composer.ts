import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createComposerApi(): Pick<LocalChatApi, 'composerResources' | 'composerDrafts'> {
  return {
    composerResources: Object.freeze({
      accept: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesAccept, input),
      complete: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesComplete, input),
      fail: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesFail, input),
      list: draftId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesList, { draftId }),
      listSources: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesListSources, input),
      retry: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerResourcesRetry, input),
      selectFiles: (draftId, referencedResourceIds = []) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectFiles,
        { draftId, referencedResourceIds: [...referencedResourceIds] },
      ),
      selectSource: (input, referencedResourceIds = []) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectSource,
        { ...input, referencedResourceIds: [...referencedResourceIds] },
      ),
      selectSpaceFile: (input, referencedResourceIds = []) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectSpaceFile,
        { ...input, referencedResourceIds: [...referencedResourceIds] },
      ),
    }),
    composerDrafts: Object.freeze({
      find: draftId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsFind, { draftId }),
      discard: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsDiscard, input),
      list: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsList),
      get: draftId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsGet, { draftId }),
      open: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsOpen, input),
      save: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.composerDraftsSave, input),
    }),
  }
}
