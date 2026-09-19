import type { ChatMessageScrollMetrics } from '@/modules/tasks/widgets/transcript/chatMessageViewport'

import { isNearChatTail } from '@/modules/tasks/widgets/transcript/chatMessageViewport'

export {
  isNearChatTail,
  resolvePrependedChatScrollTop,
} from '@/modules/tasks/widgets/transcript/chatMessageViewport'

export type ChatScrollOwnership = 'detached' | 'following' | 'returning'

export interface ChatScrollState {
  observedTop: number
  ownership: ChatScrollOwnership
}

export interface ObservedChatScroll {
  movedByReader: boolean
  state: ChatScrollState
}

const CHAT_SCROLL_POSITION_EPSILON_PX = 0.5

export function createChatScrollState(): ChatScrollState {
  return {
    observedTop: 0,
    ownership: 'following',
  }
}

export function beginReturningToChatTail(state: ChatScrollState): ChatScrollState {
  return {
    ...state,
    ownership: 'returning',
  }
}

export function detachChatScroll(state: ChatScrollState): ChatScrollState {
  return {
    ...state,
    ownership: 'detached',
  }
}

export function observeChatScroll(
  state: ChatScrollState,
  metrics: ChatMessageScrollMetrics,
): ObservedChatScroll {
  const floor = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const expectedTop = Math.min(state.observedTop, floor)
  const movedByReader = Math.abs(metrics.scrollTop - expectedTop)
    > CHAT_SCROLL_POSITION_EPSILON_PX
  const ownership = isNearChatTail(metrics)
    ? 'following'
    : movedByReader ? 'detached' : state.ownership

  return {
    movedByReader,
    state: {
      observedTop: metrics.scrollTop,
      ownership,
    },
  }
}

export function recordProgrammaticChatScroll(
  state: ChatScrollState,
  metrics: ChatMessageScrollMetrics,
): ChatScrollState {
  return {
    observedTop: metrics.scrollTop,
    ownership: resolveChatTailOwnership(state.ownership, metrics),
  }
}

export function reconcileChatScrollOwnership(
  state: ChatScrollState,
  metrics: ChatMessageScrollMetrics,
): ChatScrollState {
  const ownership = resolveChatTailOwnership(state.ownership, metrics)
  return ownership === state.ownership
    ? state
    : { observedTop: metrics.scrollTop, ownership }
}

function resolveChatTailOwnership(
  ownership: ChatScrollOwnership,
  metrics: ChatMessageScrollMetrics,
): ChatScrollOwnership {
  return isNearChatTail(metrics) ? 'following' : ownership
}
