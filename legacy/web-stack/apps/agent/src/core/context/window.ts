import type {
  AgentChatContextMessage,
  AgentContextPolicy,
} from '@haohaoxue/lexora-contracts'

export interface AgentContextWindow {
  olderMessagesExcerpt: string
  messages: AgentChatContextMessage[]
}

export const DEFAULT_AGENT_RECENT_USER_TURN_LIMIT = 3
const DEFAULT_AGENT_RECENT_MESSAGE_LIMIT = 20
const DEFAULT_AGENT_OLDER_MESSAGES_EXCERPT_MAX_LENGTH = 2_000

export function trimAgentContextWindow(
  input: AgentContextWindow,
  contextPolicy?: AgentContextPolicy | null,
): AgentContextWindow {
  const recentUserTurnLimit = contextPolicy?.recentUserTurnLimit ?? DEFAULT_AGENT_RECENT_USER_TURN_LIMIT
  const recentMessageLimit = contextPolicy?.recentMessageLimit ?? DEFAULT_AGENT_RECENT_MESSAGE_LIMIT
  const olderMessagesExcerptMaxLength = contextPolicy?.olderMessagesExcerptMaxLength
    ?? DEFAULT_AGENT_OLDER_MESSAGES_EXCERPT_MAX_LENGTH
  const windowStartIndex = Math.max(
    getRecentMessageWindowStartIndex(input.messages, recentUserTurnLimit),
    Math.max(0, input.messages.length - recentMessageLimit),
  )

  if (windowStartIndex <= 0) {
    return input
  }

  const nextOlderMessagesExcerpt = appendAgentOlderMessagesExcerpt(
    input.olderMessagesExcerpt,
    input.messages.slice(0, windowStartIndex),
    olderMessagesExcerptMaxLength,
  )

  return {
    olderMessagesExcerpt: nextOlderMessagesExcerpt,
    messages: input.messages.slice(windowStartIndex),
  }
}

function getRecentMessageWindowStartIndex(messages: AgentChatContextMessage[], recentUserTurnLimit: number): number {
  let userTurnCount = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') {
      continue
    }

    userTurnCount += 1
    if (userTurnCount === recentUserTurnLimit) {
      return index
    }
  }

  return 0
}

function appendAgentOlderMessagesExcerpt(
  excerpt: string,
  messages: AgentChatContextMessage[],
  maxLength: number,
): string {
  const additions = messages
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n')
  const nextExcerpt = [excerpt, additions].filter(Boolean).join('\n')

  if (nextExcerpt.length <= maxLength) {
    return nextExcerpt
  }

  return nextExcerpt.slice(nextExcerpt.length - maxLength)
}
