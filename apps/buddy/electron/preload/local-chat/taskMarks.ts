import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createTaskMarksApi(): Pick<LocalChatApi, 'taskMarks'> {
  return {
    taskMarks: Object.freeze({
      list: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksList),
      create: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksCreate, input),
      update: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksUpdate, input),
      delete: (id, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksDelete, { id, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      states: conversationIds => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksStates, { conversationIds }),
      assign: (conversationId, markId, expectedAssignmentRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksAssign, { conversationId, markId, ...(expectedAssignmentRevision !== undefined ? { expectedAssignmentRevision } : {}) }),
      setRead: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksSetRead, input),
      clear: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.taskMarksClear, input),
    }),
  }
}
