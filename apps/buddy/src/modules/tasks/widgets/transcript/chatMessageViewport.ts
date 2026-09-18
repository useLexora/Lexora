export interface ChatMessageScrollMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

export interface ChatMessageScrollAnchor {
  firstLoadedItemId?: string
  rowKey?: string
  messageId: string
  messageOffsetTop: number
  metrics: ChatMessageScrollMetrics
}

export type ChatReadingPositions = Map<string, ChatMessageScrollAnchor | null>

interface ChatMessageViewportHandle {
  captureScrollAnchor: () => ChatMessageScrollAnchor | null
  readScrollMetrics: () => ChatMessageScrollMetrics | null
  restoreScrollAnchor: (anchor: ChatMessageScrollAnchor) => ChatMessageScrollMetrics | null
  scrollToMessage: (messageId: string, behavior?: ScrollBehavior) => ChatMessageScrollMetrics | null
  scrollToTail: () => ChatMessageScrollMetrics | null
}

export interface BuddyChatMessageListHandle extends ChatMessageViewportHandle {
  highlightMessage: (messageId: string) => void
}

export interface BuddyChatTranscriptViewportHandle extends ChatMessageViewportHandle {
  scrollBy: (deltaY: number) => void
}

export function createChatFrameTask(
  task: () => void,
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (frameId: number) => void,
) {
  let frameId: number | null = null

  return {
    cancel() {
      if (frameId === null)
        return
      cancelFrame(frameId)
      frameId = null
    },
    schedule() {
      if (frameId !== null)
        return
      frameId = requestFrame(() => {
        frameId = null
        task()
      })
    },
  }
}

const CHAT_TAIL_TOLERANCE_PX = 48

export function isNearChatTail(metrics: ChatMessageScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= CHAT_TAIL_TOLERANCE_PX
}

export function resolvePrependedChatScrollTop(
  anchor: ChatMessageScrollMetrics,
  current: ChatMessageScrollMetrics,
): number {
  const nextTop = anchor.scrollTop + current.scrollHeight - anchor.scrollHeight
  return Math.min(Math.max(0, nextTop), Math.max(0, current.scrollHeight - current.clientHeight))
}
