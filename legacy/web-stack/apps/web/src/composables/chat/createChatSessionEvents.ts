import type { ChatApi } from './createChatApi'
import type { ChatSessionEvent } from '@/apis/chat'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function createChatSessionEvents(api: ChatApi) {
  const RECONNECT_BASE_DELAY_MS = 1_000
  const RECONNECT_MAX_DELAY_MS = 30_000

  let eventController: AbortController | null = null
  let eventSessionId: string | null = null
  let eventAfterSequence: number | null = null
  let eventHandler: ((event: ChatSessionEvent) => void | Promise<void>) | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  function startSessionEventStream(
    sessionId: string,
    afterSequence: number | null,
    onEvent: (event: ChatSessionEvent) => void | Promise<void>,
  ): void {
    if (eventSessionId === sessionId && eventController && eventAfterSequence === afterSequence) {
      return
    }

    stopSessionEventStream()
    eventHandler = onEvent
    openSessionEventStream(sessionId, afterSequence)
  }

  function openSessionEventStream(
    sessionId: string,
    afterSequence: number | null,
  ): void {
    clearReconnectTimer()
    eventSessionId = sessionId
    eventAfterSequence = afterSequence
    const controller = new AbortController()
    eventController = controller

    void api.streamEvents(
      sessionId,
      afterSequence,
      async (event) => {
        reconnectAttempt = 0
        eventAfterSequence = event.sequence
        await eventHandler?.(event)
      },
      { signal: controller.signal },
    ).then(() => {
      if (eventSessionId === sessionId && eventController === controller) {
        eventController = null
        reconnectAttempt = 0
      }
    }).catch((error) => {
      if (isAbortError(error)) {
        return
      }

      if (eventSessionId === sessionId && eventController === controller) {
        eventController = null
        scheduleReconnect()
        return
      }

      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadEvents')))
    })
  }

  function stopSessionEventStream(sessionId?: string): void {
    if (sessionId && eventSessionId !== sessionId) {
      return
    }

    eventController?.abort()
    clearReconnectTimer()
    eventController = null
    eventSessionId = null
    eventAfterSequence = null
    eventHandler = null
    reconnectAttempt = 0
  }

  function scheduleReconnect(): void {
    clearReconnectTimer()
    const reconnectDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
    )
    reconnectAttempt += 1

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null

      if (!eventSessionId || !eventHandler) {
        return
      }

      openSessionEventStream(eventSessionId, eventAfterSequence)
    }, reconnectDelay)
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return
    }

    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  return {
    startSessionEventStream,
    stopSessionEventStream,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export type ChatSessionEvents = ReturnType<typeof createChatSessionEvents>
