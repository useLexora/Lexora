import type { LocalRunEvent } from '../../../shared/runs/runApi'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createConversationApi(): Pick<LocalChatApi, 'context' | 'workspaceState' | 'conversations' | 'chat'> {
  return {
    context: Object.freeze({
      getUsageSnapshot: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.contextUsageSnapshot, input),
    }),
    workspaceState: Object.freeze({
      read: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.workspaceStateRead),
      write: value => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.workspaceStateWrite, { value }),
    }),
    conversations: Object.freeze({
      onChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.conversationsChanged, listener),
      onTimelineChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.conversationsTimelineChanged, listener),
      getNodeDetail: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsGetNodeDetail, input),
      getTree: conversationId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsGetTree, { conversationId }),
      list: limit => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsList, { limit }),
      get: conversationId => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsGet,
        { conversationId },
      ),
      delete: conversationId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsDelete, { conversationId }),
      activateBranch: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsActivateBranch, input),
      listBranches: conversationId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListBranches, { conversationId }),
      listMessages: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListMessages, input),
      rename: (conversationId, title) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsRename, { conversationId, title }),
      setPermissionSettings: (conversationId, settings) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsSetPermissionSettings,
        { conversationId, ...settings },
      ),
      setModelSelection: (conversationId, modelSelection) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsSetModelSelection,
        { conversationId, modelSelection },
      ),
      listTimeline: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListTimeline, input),
    }),
    chat: Object.freeze({
      enqueue: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatQueueEnqueue, input),
      listQueue: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatQueueList, input),
      cancelQueued: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatQueueCancel, input),
      steerQueued: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatQueueSteer, input),
      editUserMessage: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatEditUserMessage, input),
      executeCommand: request =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatExecuteCommand, request),
      startTurn: request => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatStartTurn, request),
      regenerateAssistant: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatRegenerateAssistant, input),
      cancel: runId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatCancel, { runId }),
      onRunEvent: (listener: (event: LocalRunEvent) => void) =>
        subscribe(LOCAL_CHAT_IPC_CHANNELS.runEvent, listener),
    }),
  }
}
