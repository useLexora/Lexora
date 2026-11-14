import type { LocalBuddyServiceSupervisorState } from '../../../shared/runtime/serviceState'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createRuntimeApi(): Pick<LocalChatApi, 'runtime'> {
  return {
    runtime: Object.freeze({
      listRecovery: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryList),
      acknowledgeRecovery: (id: string) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryAcknowledge, { id }),
      restoreRecovery: (id: string) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryRestore, { id }),
      getStatus: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runtimeStatus),
      restart: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runtimeRestart),
      onStateChanged: (listener: (state: LocalBuddyServiceSupervisorState) => void) =>
        subscribe(LOCAL_CHAT_IPC_CHANNELS.runtimeStateChanged, listener),
    }),
  }
}
