import type {
  BatchDeleteChatSessionsRequest,
  ChatModelSelection,
  ChatSessionEvent,
  ChatSessionOrigin,
  CreateChatSessionMessageRequest,
  EditAndSendChatMessageRequest,
  ResumeChatRunRequest,
  RetryChatAssistantMessageRequest,
  SwitchChatActiveMessageRequest,
  UpdateChatSessionTitleRequest,
} from '@/apis/chat'
import {
  batchDeleteChatSessions,
  cancelChatRun,
  createChatSession,
  deleteChatSession,
  editAndSendChatMessage,
  getChatSession,
  getChatSessions,
  resumeChatRun,
  retryChatAssistantMessage,
  sendChatSessionMessage,
  streamChatSessionEvents,
  switchChatActiveMessage,
  updateChatSessionModel,
  updateChatSessionTitle,
} from '@/apis/chat'
import { translate } from '@/i18n'

export interface CreateChatApiOptions {
  getWorkspaceId: () => string | null | undefined
}

export function createChatApi(origin: ChatSessionOrigin, options: CreateChatApiOptions) {
  function getWorkspaceId() {
    const workspaceId = options.getWorkspaceId()?.trim()

    if (!workspaceId) {
      throw new Error(translate('chat.errors.missingWorkspace'))
    }

    return workspaceId
  }

  return {
    origin,
    getWorkspaceId,
    getSessions: () => getChatSessions({ origin, workspaceId: getWorkspaceId() }),
    createSession: () => createChatSession({ origin, workspaceId: getWorkspaceId() }),
    getSession: (sessionId: string) => getChatSession(sessionId, { origin }),
    deleteSession: (sessionId: string) => deleteChatSession(sessionId, { origin }),
    batchDeleteSessions: (data: BatchDeleteChatSessionsRequest) => batchDeleteChatSessions(data, { origin }),
    updateSessionModel: (sessionId: string, data: ChatModelSelection) => updateChatSessionModel(sessionId, data, { origin }),
    updateSessionTitle: (sessionId: string, data: UpdateChatSessionTitleRequest) => updateChatSessionTitle(sessionId, data, { origin }),
    sendMessage: (sessionId: string, data: CreateChatSessionMessageRequest) => sendChatSessionMessage(sessionId, data, { origin }),
    editAndSendMessage: (sessionId: string, messageId: string, data: EditAndSendChatMessageRequest) =>
      editAndSendChatMessage(sessionId, messageId, data, { origin }),
    retryAssistantMessage: (sessionId: string, messageId: string, data: RetryChatAssistantMessageRequest = {}) =>
      retryChatAssistantMessage(sessionId, messageId, data, { origin }),
    switchActiveMessage: (sessionId: string, data: SwitchChatActiveMessageRequest) => switchChatActiveMessage(sessionId, data, { origin }),
    cancelRun: (runId: string) => cancelChatRun(runId, { origin }),
    resumeRun: (runId: string, data: ResumeChatRunRequest) => resumeChatRun(runId, data, { origin }),
    streamEvents: (
      sessionId: string,
      afterSequence: number | null,
      onEvent: (event: ChatSessionEvent) => void | Promise<void>,
      options: { signal?: AbortSignal } = {},
    ) => streamChatSessionEvents(sessionId, afterSequence, onEvent, { ...options, origin }),
  }
}

export type ChatApi = ReturnType<typeof createChatApi>
