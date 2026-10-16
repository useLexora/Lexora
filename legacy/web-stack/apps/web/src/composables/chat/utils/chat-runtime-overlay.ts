import type {
  ChatMessage,
  ChatRunSummary,
  ChatSessionDetail,
  ChatSessionEvent,
  ChatTokenUsageAggregate,
} from '@/apis/chat'
import {
  CHAT_MESSAGE_STATUS,
  CHAT_RUN_STATUS,
  CHAT_SESSION_EVENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import dayjs from 'dayjs'
import { applyChatSessionEventToMessages } from './chat-stream-message'

export type ChatSessionRuntimeStatus = 'idle' | 'streaming' | 'reconnecting'

export interface ChatRuntimeOverlayState {
  cursorBySessionId: Map<string, number>
  currentRunBySessionId: Map<string, ChatRunSummary | null>
  mergedMessagesBySessionId: Map<string, ChatMessage[]>
  pendingUserMessagesBySessionId: Map<string, ChatMessage[]>
  temporarySession: ChatSessionDetail | null
  terminalRunIdsBySessionId: Map<string, Set<string>>
  terminalMessageIdsBySessionId: Map<string, Set<string>>
  assistantMessageIdByRunId: Map<string, string>
  pausedSessionIds: Set<string>
}

export function createChatRuntimeOverlayState(): ChatRuntimeOverlayState {
  return {
    cursorBySessionId: new Map(),
    currentRunBySessionId: new Map(),
    mergedMessagesBySessionId: new Map(),
    pendingUserMessagesBySessionId: new Map(),
    temporarySession: null,
    terminalRunIdsBySessionId: new Map(),
    terminalMessageIdsBySessionId: new Map(),
    assistantMessageIdByRunId: new Map(),
    pausedSessionIds: new Set(),
  }
}

export function seedChatRuntimeOverlayFromSnapshot(
  state: ChatRuntimeOverlayState,
  session: ChatSessionDetail,
): boolean {
  const currentCursor = state.cursorBySessionId.get(session.id)
  if (currentCursor !== undefined && session.latestSequence < currentCursor) {
    return false
  }

  state.cursorBySessionId.set(session.id, Math.max(currentCursor ?? 0, session.latestSequence))
  state.pausedSessionIds.delete(session.id)
  state.mergedMessagesBySessionId.set(session.id, session.messages)

  if (session.activeRun && !isTerminalRunId(state, session.id, session.activeRun.runId)) {
    state.currentRunBySessionId.set(session.id, session.activeRun)
    state.assistantMessageIdByRunId.set(session.activeRun.runId, session.activeRun.assistantMessageId)
  }
  else {
    state.currentRunBySessionId.set(session.id, null)
  }

  return true
}

export function seedChatRuntimeOverlayFromMutationResponse(
  state: ChatRuntimeOverlayState,
  input: {
    session: ChatSessionDetail
    latestSequence: number
    run?: ChatRunSummary
  },
): void {
  seedChatRuntimeOverlayFromSnapshot(state, {
    ...input.session,
    latestSequence: Math.max(input.session.latestSequence, input.latestSequence),
  })
  clearChatPendingUserMessages(state, input.session.id)
  state.cursorBySessionId.set(input.session.id, input.latestSequence)

  if (input.run && !isTerminalRunId(state, input.session.id, input.run.runId)) {
    state.currentRunBySessionId.set(input.session.id, input.run)
    state.assistantMessageIdByRunId.set(input.run.runId, input.run.assistantMessageId)
  }
}

export function applyChatRuntimeOverlayEvent(
  state: ChatRuntimeOverlayState,
  event: ChatSessionEvent,
): boolean {
  const currentCursor = state.cursorBySessionId.get(event.sessionId) ?? 0
  if (event.sequence <= currentCursor && event.type !== CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED) {
    return false
  }

  if (event.type === CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED) {
    state.cursorBySessionId.set(event.sessionId, event.payload.latestSequence)
    state.pausedSessionIds.add(event.sessionId)
    return true
  }

  state.cursorBySessionId.set(event.sessionId, event.sequence)

  if (event.runId && event.messageId) {
    state.assistantMessageIdByRunId.set(event.runId, event.messageId)
  }

  if (event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA && shouldDropDelta(state, event)) {
    return true
  }

  if (event.type === CHAT_SESSION_EVENT_TYPE.RUN_STARTED) {
    updateCurrentRun(state, event, CHAT_RUN_STATUS.RUNNING)
    return true
  }

  if (event.type === CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION) {
    updateCurrentRun(state, event, CHAT_RUN_STATUS.REQUIRES_ACTION)
    return true
  }

  if (isTerminalRunEvent(event)) {
    markTerminalRun(state, event)
    const terminalMessageEvent = createMessageTerminalEventFromRunEvent(state, event)
    if (terminalMessageEvent) {
      applyMergedMessages(state, terminalMessageEvent)
    }
    return true
  }

  if (isMessagePatchEvent(event)) {
    applyMergedMessages(state, event)
  }

  if (isTerminalMessageEvent(event)) {
    markTerminalMessage(state, event)
  }

  return true
}

export function mergeChatRenderSession(
  session: ChatSessionDetail,
  state: ChatRuntimeOverlayState,
): ChatSessionDetail {
  const currentRun = getChatRuntimeOverlayCurrentRun(state, session.id)
  const cursor = getChatRuntimeOverlayCursor(state, session.id)
  const messages = mergePendingUserMessages(
    state.mergedMessagesBySessionId.get(session.id) ?? session.messages,
    state.pendingUserMessagesBySessionId.get(session.id) ?? [],
  )
  const activePathUsage = aggregateChatMessageUsage(messages)

  return {
    ...session,
    latestSequence: Math.max(session.latestSequence, cursor ?? 0),
    activeRun: currentRun,
    messages,
    usage: {
      activePath: activePathUsage,
      session: addUsageDelta(session.usage.session, subtractUsage(activePathUsage, session.usage.activePath)),
    },
  }
}

export function stageChatPendingUserMessage(
  state: ChatRuntimeOverlayState,
  input: {
    session: ChatSessionDetail
    message: ChatMessage
    temporary?: boolean
  },
): void {
  const currentMessages = state.pendingUserMessagesBySessionId.get(input.session.id) ?? []
  const nextMessages = [
    ...currentMessages.filter(message => message.id !== input.message.id),
    input.message,
  ]

  state.pendingUserMessagesBySessionId.set(input.session.id, nextMessages)
  if (input.temporary) {
    if (state.temporarySession && state.temporarySession.id !== input.session.id) {
      state.pendingUserMessagesBySessionId.delete(state.temporarySession.id)
    }
    state.temporarySession = mergeChatRenderSession(input.session, state)
  }
}

export function moveChatPendingUserMessages(
  state: ChatRuntimeOverlayState,
  input: {
    fromSessionId: string
    toSession: ChatSessionDetail
  },
): void {
  const messages = state.pendingUserMessagesBySessionId.get(input.fromSessionId)
  if (!messages?.length) {
    return
  }

  state.pendingUserMessagesBySessionId.delete(input.fromSessionId)
  state.pendingUserMessagesBySessionId.set(input.toSession.id, [
    ...(state.pendingUserMessagesBySessionId.get(input.toSession.id) ?? []),
    ...messages,
  ])

  if (state.temporarySession?.id === input.fromSessionId) {
    state.temporarySession = null
  }
}

export function markChatPendingUserMessageFailed(
  state: ChatRuntimeOverlayState,
  input: {
    sessionId: string
    messageId: string
  },
): void {
  const currentMessages = state.pendingUserMessagesBySessionId.get(input.sessionId) ?? []
  const nextMessages = currentMessages.map(message =>
    message.id === input.messageId
      ? {
          ...message,
          status: CHAT_MESSAGE_STATUS.FAILED,
          updatedAt: dayjs().toISOString(),
        }
      : message,
  )

  state.pendingUserMessagesBySessionId.set(input.sessionId, nextMessages)
  if (state.temporarySession?.id === input.sessionId) {
    state.temporarySession = mergeChatRenderSession(state.temporarySession, state)
  }
}

export function clearChatPendingUserMessages(
  state: ChatRuntimeOverlayState,
  sessionId: string,
): void {
  state.pendingUserMessagesBySessionId.delete(sessionId)
  if (state.temporarySession?.id === sessionId) {
    state.temporarySession = null
  }
}

export function clearChatRuntimeOverlayTemporarySession(state: ChatRuntimeOverlayState): void {
  const temporarySessionId = state.temporarySession?.id
  if (!temporarySessionId) {
    return
  }

  clearChatPendingUserMessages(state, temporarySessionId)
}

export function getChatRuntimeOverlayTemporarySession(state: ChatRuntimeOverlayState): ChatSessionDetail | null {
  return state.temporarySession
    ? mergeChatRenderSession(state.temporarySession, state)
    : null
}

export function getChatRuntimeOverlayCursor(
  state: ChatRuntimeOverlayState,
  sessionId: string,
): number | null {
  return state.cursorBySessionId.get(sessionId) ?? null
}

export function getChatRuntimeOverlayCurrentRun(
  state: ChatRuntimeOverlayState,
  sessionId: string,
): ChatRunSummary | null {
  return state.currentRunBySessionId.get(sessionId) ?? null
}

export function getChatRuntimeOverlayCancelRunId(
  state: ChatRuntimeOverlayState,
  sessionId: string | null,
): string | null {
  if (!sessionId) {
    return null
  }

  const currentRun = getChatRuntimeOverlayCurrentRun(state, sessionId)
  return isActiveRun(currentRun) ? currentRun.runId : null
}

export function getChatRuntimeOverlayIsStreaming(
  state: ChatRuntimeOverlayState,
  sessionId: string | null,
): boolean {
  if (!sessionId) {
    return false
  }

  return isActiveRun(getChatRuntimeOverlayCurrentRun(state, sessionId))
}

export function getChatRuntimeOverlayStatus(
  state: ChatRuntimeOverlayState,
  sessionId: string | null,
): ChatSessionRuntimeStatus {
  if (!sessionId) {
    return 'idle'
  }

  if (state.pausedSessionIds.has(sessionId)) {
    return 'reconnecting'
  }

  return isActiveRun(getChatRuntimeOverlayCurrentRun(state, sessionId)) ? 'streaming' : 'idle'
}

export function clearChatRuntimeOverlaySession(
  state: ChatRuntimeOverlayState,
  sessionId: string,
): void {
  state.cursorBySessionId.delete(sessionId)
  state.currentRunBySessionId.delete(sessionId)
  state.mergedMessagesBySessionId.delete(sessionId)
  clearChatPendingUserMessages(state, sessionId)
  state.terminalRunIdsBySessionId.delete(sessionId)
  state.terminalMessageIdsBySessionId.delete(sessionId)
  state.pausedSessionIds.delete(sessionId)
}

function isActiveRun(run: ChatRunSummary | null): run is ChatRunSummary {
  return run?.status === CHAT_RUN_STATUS.PENDING
    || run?.status === CHAT_RUN_STATUS.RUNNING
    || run?.status === CHAT_RUN_STATUS.REQUIRES_ACTION
}

function updateCurrentRun(
  state: ChatRuntimeOverlayState,
  event: ChatSessionEvent,
  status: ChatRunSummary['status'],
): void {
  if (!event.runId) {
    return
  }

  const currentRun = getChatRuntimeOverlayCurrentRun(state, event.sessionId)
  if (!currentRun || currentRun.runId !== event.runId) {
    return
  }

  state.currentRunBySessionId.set(event.sessionId, {
    ...currentRun,
    status,
    requiredAction: event.type === CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION
      ? event.payload.action
      : null,
    startedAt: currentRun.startedAt ?? event.createdAt,
  })
}

function applyMergedMessages(state: ChatRuntimeOverlayState, event: ChatSessionEvent): void {
  const current = state.mergedMessagesBySessionId.get(event.sessionId) ?? []
  state.mergedMessagesBySessionId.set(event.sessionId, applyChatSessionEventToMessages(current, event))
}

function shouldDropDelta(
  state: ChatRuntimeOverlayState,
  event: Extract<ChatSessionEvent, { type: typeof CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA }>,
): boolean {
  return isTerminalRunId(state, event.sessionId, event.runId)
    || isTerminalMessageId(state, event.sessionId, event.messageId)
}

function markTerminalRun(state: ChatRuntimeOverlayState, event: ChatSessionEvent): void {
  if (!event.runId) {
    return
  }

  addTerminalRunId(state, event.sessionId, event.runId)

  const currentRun = getChatRuntimeOverlayCurrentRun(state, event.sessionId)
  if (currentRun?.runId === event.runId) {
    state.currentRunBySessionId.set(event.sessionId, null)
  }
}

function markTerminalMessage(state: ChatRuntimeOverlayState, event: ChatSessionEvent): void {
  if (!event.messageId) {
    return
  }

  addTerminalMessageId(state, event.sessionId, event.messageId)

  if (event.runId) {
    addTerminalRunId(state, event.sessionId, event.runId)
  }

  const currentRun = getChatRuntimeOverlayCurrentRun(state, event.sessionId)
  if (event.runId && currentRun?.runId === event.runId) {
    state.currentRunBySessionId.set(event.sessionId, null)
  }
}

function createMessageTerminalEventFromRunEvent(
  state: ChatRuntimeOverlayState,
  event: ChatSessionEvent,
): ChatSessionEvent | null {
  if (!event.runId) {
    return null
  }

  const messageId = state.assistantMessageIdByRunId.get(event.runId)
  if (!messageId) {
    return null
  }

  const status = getRunTerminalMessageStatus(event.type)
  if (!status) {
    return null
  }

  addTerminalMessageId(state, event.sessionId, messageId)

  return {
    ...event,
    type: CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED,
    messageId,
    payload: {
      status,
    },
  } as ChatSessionEvent
}

function getRunTerminalMessageStatus(eventType: ChatSessionEvent['type']) {
  if (eventType === CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED) {
    return CHAT_MESSAGE_STATUS.COMPLETED
  }

  if (eventType === CHAT_SESSION_EVENT_TYPE.RUN_FAILED) {
    return CHAT_MESSAGE_STATUS.FAILED
  }

  if (eventType === CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED) {
    return CHAT_MESSAGE_STATUS.CANCELLED
  }

  return null
}

function isMessagePatchEvent(event: ChatSessionEvent): boolean {
  return event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED
}

function isTerminalMessageEvent(event: ChatSessionEvent): boolean {
  return event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED
    || event.type === CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED
}

function isTerminalRunEvent(event: ChatSessionEvent): boolean {
  return event.type === CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED
    || event.type === CHAT_SESSION_EVENT_TYPE.RUN_FAILED
    || event.type === CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED
}

function mergePendingUserMessages(messages: ChatMessage[], pendingMessages: ChatMessage[]): ChatMessage[] {
  if (pendingMessages.length === 0) {
    return messages
  }

  const messageIds = new Set(messages.map(message => message.id))
  const appendedMessages = pendingMessages.filter(message => !messageIds.has(message.id))

  return appendedMessages.length > 0
    ? [...messages, ...appendedMessages]
    : messages
}

function aggregateChatMessageUsage(messages: ChatMessage[]): ChatTokenUsageAggregate {
  return messages.reduce<ChatTokenUsageAggregate>((total, message) => {
    const usage = message.role === 'assistant' ? message.metadata?.usage : null
    if (!usage) {
      return total
    }

    return {
      generationCount: total.generationCount + 1,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }
  }, createEmptyUsage())
}

function subtractUsage(
  current: ChatTokenUsageAggregate,
  baseline: ChatTokenUsageAggregate,
): ChatTokenUsageAggregate {
  return {
    generationCount: Math.max(0, current.generationCount - baseline.generationCount),
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - baseline.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
  }
}

function addUsageDelta(
  base: ChatTokenUsageAggregate,
  delta: ChatTokenUsageAggregate,
): ChatTokenUsageAggregate {
  return {
    generationCount: base.generationCount + delta.generationCount,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    reasoningTokens: base.reasoningTokens + delta.reasoningTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
  }
}

function createEmptyUsage(): ChatTokenUsageAggregate {
  return {
    generationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

function addTerminalRunId(
  state: ChatRuntimeOverlayState,
  sessionId: string,
  runId: string,
): void {
  const terminalRunIds = state.terminalRunIdsBySessionId.get(sessionId) ?? new Set<string>()
  terminalRunIds.add(runId)
  state.terminalRunIdsBySessionId.set(sessionId, terminalRunIds)
}

function addTerminalMessageId(
  state: ChatRuntimeOverlayState,
  sessionId: string,
  messageId: string,
): void {
  const terminalMessageIds = state.terminalMessageIdsBySessionId.get(sessionId) ?? new Set<string>()
  terminalMessageIds.add(messageId)
  state.terminalMessageIdsBySessionId.set(sessionId, terminalMessageIds)
}

function isTerminalRunId(
  state: ChatRuntimeOverlayState,
  sessionId: string,
  runId: string,
): boolean {
  return state.terminalRunIdsBySessionId.get(sessionId)?.has(runId) ?? false
}

function isTerminalMessageId(
  state: ChatRuntimeOverlayState,
  sessionId: string,
  messageId: string,
): boolean {
  return state.terminalMessageIdsBySessionId.get(sessionId)?.has(messageId) ?? false
}
