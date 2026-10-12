import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createBuddiesApi(): Pick<LocalChatApi, 'buddies'> {
  return {
    buddies: Object.freeze({
      toolOptions: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesToolOptions),
      list: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesList),
      get: buddyId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesGet, { buddyId }),
      create: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesCreate, input),
      delete: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesDelete, input),
      resetProfile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesResetProfile, input),
      setDefault: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesSetDefault, input),
      update: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.buddiesUpdate, input),
      onChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.buddiesChanged, listener),
    }),
  }
}
