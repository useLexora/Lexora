import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createQuestionsApi(): Pick<LocalChatApi, 'questions'> {
  return { questions: Object.freeze({
    list: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.questionsList, input),
    answer: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.questionsAnswer, input),
    retry: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.questionsRetry, input),
    cancel: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.questionsCancel, input),
    onChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.questionsChanged, listener),
  }) }
}
