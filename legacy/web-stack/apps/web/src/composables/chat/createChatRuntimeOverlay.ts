import type { ChatSessionController } from './createChatSessionController'
import type { ChatMutationResponse, ChatSessionDetail, ChatSessionEvent } from '@/apis/chat'
import { computed, shallowRef, watch } from 'vue'
import {
  applyChatRuntimeOverlayEvent,
  clearChatRuntimeOverlayTemporarySession,
  createChatRuntimeOverlayState,
  getChatRuntimeOverlayCancelRunId,
  getChatRuntimeOverlayCurrentRun,
  getChatRuntimeOverlayCursor,
  getChatRuntimeOverlayIsStreaming,
  getChatRuntimeOverlayStatus,
  getChatRuntimeOverlayTemporarySession,
  markChatPendingUserMessageFailed,
  mergeChatRenderSession,
  moveChatPendingUserMessages,
  seedChatRuntimeOverlayFromMutationResponse,
  seedChatRuntimeOverlayFromSnapshot,
  stageChatPendingUserMessage,
} from './utils/chat-runtime-overlay'

export function createChatRuntimeOverlay(sessionController: ChatSessionController) {
  const { activeSession, activeSessionId } = sessionController
  const overlayState = createChatRuntimeOverlayState()
  const overlayVersion = shallowRef(0)

  const renderSession = computed<ChatSessionDetail | null>(() => {
    trackOverlayVersion()
    return activeSession.value
      ? mergeChatRenderSession(activeSession.value, overlayState)
      : getChatRuntimeOverlayTemporarySession(overlayState)
  })
  const currentRun = computed(() => {
    trackOverlayVersion()
    return activeSessionId.value
      ? getChatRuntimeOverlayCurrentRun(overlayState, activeSessionId.value)
      : null
  })
  const cancelRunId = computed(() => {
    trackOverlayVersion()
    return getChatRuntimeOverlayCancelRunId(overlayState, activeSessionId.value)
  })
  const isStreaming = computed(() => {
    trackOverlayVersion()
    return getChatRuntimeOverlayIsStreaming(overlayState, activeSessionId.value)
  })
  const activeCursor = computed(() => {
    trackOverlayVersion()
    return activeSessionId.value
      ? getChatRuntimeOverlayCursor(overlayState, activeSessionId.value)
      : null
  })
  const status = computed(() => {
    trackOverlayVersion()
    return getChatRuntimeOverlayStatus(overlayState, activeSessionId.value)
  })

  watch(activeSession, (session) => {
    if (session) {
      if (seedChatRuntimeOverlayFromSnapshot(overlayState, session)) {
        touch()
      }
      return
    }

    touch()
  }, { immediate: true })

  function seedFromMutationResponse(response: ChatMutationResponse): void {
    seedChatRuntimeOverlayFromMutationResponse(overlayState, response)
    touch()
  }

  function applyEvent(event: ChatSessionEvent): boolean {
    const changed = applyChatRuntimeOverlayEvent(overlayState, event)
    if (changed) {
      touch()
    }
    return changed
  }

  function stagePendingUserMessage(input: Parameters<typeof stageChatPendingUserMessage>[1]): void {
    stageChatPendingUserMessage(overlayState, input)
    touch()
  }

  function movePendingUserMessages(input: Parameters<typeof moveChatPendingUserMessages>[1]): void {
    moveChatPendingUserMessages(overlayState, input)
    touch()
  }

  function markPendingUserMessageFailed(input: Parameters<typeof markChatPendingUserMessageFailed>[1]): void {
    markChatPendingUserMessageFailed(overlayState, input)
    touch()
  }

  function clearTemporarySession(): void {
    clearChatRuntimeOverlayTemporarySession(overlayState)
    touch()
  }

  function touch(): void {
    overlayVersion.value += 1
  }

  function trackOverlayVersion(): number {
    return overlayVersion.value
  }

  return {
    activeCursor,
    applyEvent,
    cancelRunId,
    clearTemporarySession,
    currentRun,
    isStreaming,
    markPendingUserMessageFailed,
    movePendingUserMessages,
    renderSession,
    seedFromMutationResponse,
    stagePendingUserMessage,
    status,
  }
}

export type ChatRuntimeOverlay = ReturnType<typeof createChatRuntimeOverlay>
