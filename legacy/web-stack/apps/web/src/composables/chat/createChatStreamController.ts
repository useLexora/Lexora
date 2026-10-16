import type {
  AgentClientAction,
  AgentClientActionResult,
} from '@haohaoxue/lexora-contracts/agent/client-action'
import type { ChatApi } from './createChatApi'
import type { ChatRuntimeOverlay } from './createChatRuntimeOverlay'
import type { ChatSessionController } from './createChatSessionController'
import type { ChatSessionEvents } from './createChatSessionEvents'
import type {
  ChatMessage,
  ChatModelSelection,
  ChatMutationResponse,
  ChatSessionDetail,
  ChatSessionEvent,
  CreateChatSessionMessageRequest,
  EditAndSendChatMessageRequest,
} from '@/apis/chat'
import { AGENT_TIME_SKILL_KEY } from '@haohaoxue/lexora-contracts/agent'
import {
  CHAT_MESSAGE_STATUS,
  CHAT_RUN_STATUS,
  CHAT_SESSION_CHANNEL,
  CHAT_SESSION_DEFAULT_TITLE,
  CHAT_SESSION_EVENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import dayjs from 'dayjs'
import { shallowRef, watch } from 'vue'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { resolveBrowserTimeZone } from '@/utils/time-zone'

export interface ChatStreamControllerOptions {
  onSessionCreated?: (sessionId: string) => Promise<void> | void
}

type ChatMemoryRunOptions = CreateChatSessionMessageRequest['memory']

export interface SendChatComposerMessageInput extends Omit<CreateChatSessionMessageRequest, 'memory' | 'disabledSkillKeys'> {
  memory?: ChatMemoryRunOptions
  disabledSkillKeys?: CreateChatSessionMessageRequest['disabledSkillKeys']
  modelRef?: ChatModelSelection['modelRef'] | null
}

type EditAndSendChatComposerMessageInput = Omit<EditAndSendChatMessageRequest, 'memory' | 'disabledSkillKeys'> & {
  memory?: ChatMemoryRunOptions
  disabledSkillKeys?: EditAndSendChatMessageRequest['disabledSkillKeys']
}

export function createChatStreamController(
  sessions: ChatSessionController,
  runtimeOverlay: ChatRuntimeOverlay,
  sessionEvents: ChatSessionEvents,
  api: ChatApi,
  options: ChatStreamControllerOptions = {},
) {
  const {
    activeSession,
    activeSessionId,
    createSession,
    patchSessionSummary,
    refreshActiveSession,
    replaceActiveSession,
    selectSession,
  } = sessions
  const {
    activeCursor,
    applyEvent,
    cancelRunId,
    currentRun,
    isStreaming,
    markPendingUserMessageFailed,
    movePendingUserMessages,
    seedFromMutationResponse,
    stagePendingUserMessage,
  } = runtimeOverlay
  const {
    startSessionEventStream,
    stopSessionEventStream,
  } = sessionEvents
  const pendingClientActionKeys = new Set<string>()
  const isSubmitting = shallowRef(false)

  watch(activeSessionId, (sessionId, previousSessionId) => {
    if (previousSessionId && previousSessionId !== sessionId) {
      stopSessionEventStream(previousSessionId)
    }

    if (sessionId && currentRun.value) {
      startActiveSessionEventStream()
    }
  })

  watch(currentRun, (run) => {
    if (!activeSessionId.value) {
      return
    }

    if (run) {
      startActiveSessionEventStream()
      if (run.status === CHAT_RUN_STATUS.REQUIRES_ACTION && run.requiredAction) {
        void handleClientAction(run.runId, run.requiredAction)
      }
      return
    }

    stopSessionEventStream(activeSessionId.value)
  }, { immediate: true })

  async function sendMessage(input: SendChatComposerMessageInput): Promise<boolean> {
    const content = input.content.trim()
    if (!content || isSubmitting.value || isStreaming.value) {
      return false
    }

    isSubmitting.value = true
    let pendingSubmission: PendingSubmission | null = null
    let pendingSessionId: string | null = null

    try {
      pendingSubmission = stagePendingSubmission(input, content)
      pendingSessionId = pendingSubmission.sessionId
      const session = await ensureSessionReady(input.modelRef)
      if (!session) {
        markPendingUserMessageFailed({
          sessionId: pendingSessionId,
          messageId: pendingSubmission.messageId,
        })
        return false
      }

      if (pendingSubmission.sessionId !== session.id) {
        movePendingUserMessages({
          fromSessionId: pendingSubmission.sessionId,
          toSession: session,
        })
        pendingSessionId = session.id
      }

      handleMutationResponse(await api.sendMessage(session.id, {
        content,
        contentJSON: input.contentJSON,
        attachments: input.attachments ?? [],
        memory: input.memory ?? { ignoredForRun: false },
        skillInvocation: input.skillInvocation ?? null,
        disabledSkillKeys: input.disabledSkillKeys ?? [],
        runtimeHints: input.runtimeHints ?? createBrowserRuntimeHints(),
      }))
      return true
    }
    catch (error) {
      if (pendingSubmission) {
        markPendingUserMessageFailed({
          sessionId: pendingSessionId ?? pendingSubmission.sessionId,
          messageId: pendingSubmission.messageId,
        })
      }
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.send')))
      return false
    }
    finally {
      isSubmitting.value = false
    }
  }

  async function editAndSendMessage(messageId: string, payload: EditAndSendChatComposerMessageInput): Promise<boolean> {
    const content = payload.content.trim()
    if (!activeSession.value || !content || isSubmitting.value || isStreaming.value) {
      return false
    }

    try {
      handleMutationResponse(await api.editAndSendMessage(activeSession.value.id, messageId, {
        content,
        contentJSON: payload.contentJSON,
        attachments: payload.attachments ?? [],
        memory: payload.memory ?? { ignoredForRun: false },
        skillInvocation: payload.skillInvocation ?? null,
        disabledSkillKeys: payload.disabledSkillKeys ?? [],
        runtimeHints: payload.runtimeHints ?? createBrowserRuntimeHints(),
      }))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.send')))
      return false
    }
  }

  async function retryMessage(messageId: string): Promise<boolean> {
    if (!activeSession.value || isSubmitting.value || isStreaming.value) {
      return false
    }

    try {
      handleMutationResponse(await api.retryAssistantMessage(activeSession.value.id, messageId, {
        runtimeHints: createBrowserRuntimeHints(),
      }))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.retry')))
      return false
    }
  }

  async function switchBranch(messageId: string): Promise<boolean> {
    if (!activeSession.value || isSubmitting.value || isStreaming.value) {
      return false
    }

    try {
      handleMutationResponse(await api.switchActiveMessage(activeSession.value.id, {
        messageId,
      }))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.switchBranch')))
      return false
    }
  }

  async function cancelActiveRun(): Promise<boolean> {
    if (!cancelRunId.value) {
      return false
    }

    try {
      handleMutationResponse(await api.cancelRun(cancelRunId.value))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.stop')))
      return false
    }
  }

  function handleMutationResponse(response: ChatMutationResponse): void {
    const accepted = replaceActiveSession(response.session)
    if (!accepted) {
      return
    }

    seedFromMutationResponse(response)

    if (response.run) {
      startSessionEventStream(response.session.id, response.latestSequence, handleSessionEvent)
    }
  }

  async function handleSessionEvent(event: ChatSessionEvent): Promise<void> {
    if (event.sessionId !== activeSessionId.value) {
      return
    }

    if (!applyEvent(event)) {
      return
    }

    if (event.type === CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED) {
      const session = await refreshActiveSession(event.sessionId)
      if (session) {
        startSessionEventStream(event.sessionId, event.payload.latestSequence, handleSessionEvent)
      }
      return
    }

    if (event.type === CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_CREATED) {
      const session = await refreshActiveSession(event.sessionId)
      if (session && currentRun.value) {
        startActiveSessionEventStream()
      }
      return
    }

    if (event.type === CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION) {
      await handleClientAction(event.runId, event.payload.action)
      return
    }

    if (isTerminalEvent(event)) {
      if (!isStreaming.value) {
        stopSessionEventStream(event.sessionId)
      }

      patchSessionSummary(event.sessionId, {
        updatedAt: event.createdAt,
      })
    }
  }

  async function handleClientAction(
    runId: string,
    action: AgentClientAction,
  ): Promise<void> {
    const actionKey = `${runId}:${action.type}:${action.toolCallId}`
    if (pendingClientActionKeys.has(actionKey)) {
      return
    }

    pendingClientActionKeys.add(actionKey)
    try {
      handleMutationResponse(await api.resumeRun(runId, {
        resume: await resolveClientActionResult(action),
      }))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.send')))
    }
    finally {
      pendingClientActionKeys.delete(actionKey)
    }
  }

  function stagePendingSubmission(input: SendChatComposerMessageInput, content: string): PendingSubmission {
    const createdAt = dayjs().toISOString()
    const currentSession = activeSession.value
    const session = currentSession ?? createTemporaryChatSession({
      id: createLocalChatId('chat-session'),
      workspaceId: api.getWorkspaceId(),
      origin: api.origin,
      modelRef: input.modelRef ?? null,
      createdAt,
    })
    const message = createPendingUserMessage({
      id: createLocalChatId('chat-message'),
      content,
      input,
      createdAt,
    })

    stagePendingUserMessage({
      session,
      message,
      temporary: !currentSession,
    })

    return {
      messageId: message.id,
      sessionId: session.id,
    }
  }

  async function ensureSessionReady(modelRef?: ChatModelSelection['modelRef'] | null) {
    let sessionId = activeSessionId.value
    if (!sessionId) {
      const createdSession = await createSession()
      sessionId = createdSession?.id ?? null
      if (sessionId) {
        await options.onSessionCreated?.(sessionId)
      }
    }

    if (!sessionId) {
      return null
    }

    if (!activeSession.value || activeSession.value.id !== sessionId) {
      await selectSession(sessionId)
    }

    if (modelRef && activeSession.value && !isSameModelRef(modelRef, activeSession.value.modelRef)) {
      const updatedSession = await api.updateSessionModel(activeSession.value.id, {
        modelRef,
      })
      replaceActiveSession(updatedSession)
    }

    return activeSession.value
  }

  function startActiveSessionEventStream(): void {
    if (!activeSessionId.value) {
      return
    }

    startSessionEventStream(
      activeSessionId.value,
      activeCursor.value ?? activeSession.value?.latestSequence ?? null,
      handleSessionEvent,
    )
  }

  return {
    cancelActiveRun,
    cancelRunId,
    editAndSendMessage,
    isSubmitting,
    isStreaming,
    retryMessage,
    sendMessage,
    switchBranch,
  }
}

interface PendingSubmission {
  messageId: string
  sessionId: string
}

let localChatIdSeed = 0

function createLocalChatId(prefix: string): string {
  localChatIdSeed += 1
  return `local-${prefix}-${localChatIdSeed}`
}

function createTemporaryChatSession(input: {
  id: string
  workspaceId: string
  origin: ChatSessionDetail['origin']
  modelRef: ChatModelSelection['modelRef'] | null
  createdAt: string
}): ChatSessionDetail {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    origin: input.origin,
    channel: CHAT_SESSION_CHANNEL.DIRECT,
    title: CHAT_SESSION_DEFAULT_TITLE,
    agentProfile: null,
    modelRef: input.modelRef
      ? {
          providerId: input.modelRef.providerId,
          modelId: input.modelRef.modelId,
        }
      : null,
    latestSequence: 0,
    messages: [],
    usage: createEmptySessionUsage(),
    activeRun: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }
}

function createPendingUserMessage(input: {
  id: string
  content: string
  input: SendChatComposerMessageInput
  createdAt: string
}): ChatMessage {
  return {
    id: input.id,
    role: 'user',
    status: CHAT_MESSAGE_STATUS.PENDING,
    content: input.content,
    branch: {
      index: 1,
      count: 1,
      previousMessageId: null,
      nextMessageId: null,
    },
    parts: [],
    metadata: {
      contentJSON: cloneContentJSON(input.input.contentJSON),
      attachments: toPendingMessageAttachments(input.input.attachments ?? []),
      contextSnapshotMetas: [],
      memoryOperations: [],
      skillInvocation: input.input.skillInvocation ?? null,
      disabledSkillKeys: input.input.disabledSkillKeys ?? [],
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
  }
}

function toPendingMessageAttachments(
  attachments: NonNullable<SendChatComposerMessageInput['attachments']>,
): Extract<ChatMessage, { role: 'user' }>['metadata']['attachments'] {
  return attachments.map((attachment) => {
    if (attachment.type !== 'document') {
      return attachment
    }

    const { snapshot: _snapshot, ...persistedAttachment } = attachment
    return persistedAttachment
  })
}

function cloneContentJSON(contentJSON: SendChatComposerMessageInput['contentJSON']): SendChatComposerMessageInput['contentJSON'] {
  return JSON.parse(JSON.stringify(contentJSON)) as SendChatComposerMessageInput['contentJSON']
}

function createEmptySessionUsage(): ChatSessionDetail['usage'] {
  const empty = {
    generationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }

  return {
    activePath: empty,
    session: empty,
  }
}

async function resolveClientActionResult(action: AgentClientAction): Promise<AgentClientActionResult> {
  return {
    type: action.resultType,
    toolCallId: action.toolCallId,
    error: {
      code: 'unsupported_client_action',
      message: `Unsupported client action: ${action.type}`,
    },
  }
}

function isTerminalEvent(event: ChatSessionEvent): boolean {
  return event.type === CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED
    || event.type === CHAT_SESSION_EVENT_TYPE.RUN_FAILED
    || event.type === CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED
}

function isSameModelRef(
  left: ChatModelSelection['modelRef'] | null,
  right: ChatModelSelection['modelRef'] | null,
) {
  return Boolean(left && right && left.providerId === right.providerId && left.modelId === right.modelId)
}

export type ChatStreamController = ReturnType<typeof createChatStreamController>

function createBrowserRuntimeHints(): NonNullable<CreateChatSessionMessageRequest['runtimeHints']> {
  const detectedTimeZone = resolveBrowserTimeZone()

  return {
    skillInputs: detectedTimeZone
      ? {
          [AGENT_TIME_SKILL_KEY]: {
            detectedTimeZone,
          },
        }
      : {},
  }
}
