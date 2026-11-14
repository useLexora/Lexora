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
      list: (limit, filter) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsList, { limit, filter: filter ? { spaceId: filter.spaceId, query: filter.query, excludeConversationId: filter.excludeConversationId } : undefined }),
      listHistory: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListHistory, {
        ...input,
        ...(input.excludeIds ? { excludeIds: [...input.excludeIds] } : {}),
      }),
      getHistoryEntries: ids => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsGetHistoryEntries, { ids: [...ids] }),
      get: conversationId => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsGet,
        { conversationId },
      ),
      getModelControls: (conversationId, actorId) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsGetModelControls, { conversationId, ...(actorId ? { actorId } : {}) }),
      archive: (conversationId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsArchive, { conversationId, expectedRevision }),
      restoreArchive: (conversationId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsRestoreArchive, { conversationId, expectedRevision }),
      deleteArchived: (conversationId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsDeleteArchived, { conversationId, expectedRevision }),
      listArchived: query => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListArchived, query),
      getArchivePolicy: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsGetArchivePolicy, {}),
      setArchivePolicy: days => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsSetArchivePolicy, { days }),
      delete: (conversationId, expectedRevision) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsDelete, { conversationId, ...revisionCondition(expectedRevision) }),
      activateBranch: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsActivateBranch, input),
      listBranches: conversationId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListBranches, { conversationId }),
      listMessages: input =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListMessages, input),
      rename: (conversationId, title, expectedTitleRevision) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsRename, { conversationId, title, ...(expectedTitleRevision !== undefined ? { expectedTitleRevision } : {}) }),
      setPermissionSettings: (conversationId, settings, expectedRevision) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsSetPermissionSettings,
        { conversationId, ...settings, ...revisionCondition(expectedRevision) },
      ),
      listMembers: conversationId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsListMembers, { conversationId }),
      addMember: (conversationId, buddyId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsAddMember, { conversationId, buddyId, ...revisionCondition(expectedRevision) }),
      removeMember: (conversationId, buddyId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsRemoveMember, { conversationId, buddyId, ...revisionCondition(expectedRevision) }),
      setBuddy: (conversationId, buddyId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsSetBuddy, { conversationId, buddyId, ...revisionCondition(expectedRevision) }),
      moveToSpace: (conversationId, spaceId, expectedRevision) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsMoveToSpace, { conversationId, spaceId, ...revisionCondition(expectedRevision) }),
      setModelSelection: (conversationId, modelSelection, target) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.conversationsSetModelSelection,
        { conversationId, modelSelection, ...revisionCondition(target?.expectedRevision), ...(target?.expectedRunGeneration !== undefined ? { expectedRunGeneration: target.expectedRunGeneration } : {}), ...(target?.expectedRunModelSelection !== undefined ? { expectedRunModelSelection: target.expectedRunModelSelection } : {}), ...(target?.expectedActiveRun !== undefined ? { expectedActiveRun: target.expectedActiveRun } : {}), ...(target?.actorId ? { actorId: target.actorId } : {}), ...(target?.runId ? { targetRunId: target.runId } : {}) },
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
      cancel: (runId, expectedRunGeneration) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.chatCancel, { runId, ...(expectedRunGeneration !== undefined ? { expectedRunGeneration } : {}) }),
      onRunEvent: (listener: (event: LocalRunEvent) => void) =>
        subscribe(LOCAL_CHAT_IPC_CHANNELS.runEvent, listener),
    }),
  }
}

function revisionCondition(expectedRevision: number | undefined) {
  return expectedRevision !== undefined ? { expectedRevision } : {}
}
