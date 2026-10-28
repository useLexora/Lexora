import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createExecutionsApi(): Pick<LocalChatApi, 'executions'> {
  return {
    executions: Object.freeze({
      list: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsList, input),
      detail: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsDetail, input),
      inputs: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsInputs, input),
      events: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsEvents, input),
      send: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsSend, input),
      sendDraft: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsSendDraft, input),
      cancelChildren: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsCancelChildren, input),
      answer: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsAnswer, input),
      cancel: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.executionsCancel, input),
      onChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.executionsChanged, listener),
    }),
  }
}
