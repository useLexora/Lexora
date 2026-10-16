import type { ChatMessage } from '@/apis/chat'
import type { ChatMarkdownRenderPhase } from '@/components/chat-markdown'
import type { AssistantToolCallView } from '@/composables/chat/utils/chat-message-display'

export type ChatAssistantAvatarSize = 'md' | 'sm' | 'xs'
export type ChatAssistantMessageVariant = 'global' | 'docs'
export type ChatMessageActionsVariant = 'global' | 'docs'

export interface ChatAssistantAvatarProps {
  pending?: boolean
  size?: ChatAssistantAvatarSize
}

export interface ChatAssistantMessageProps {
  message: ChatMessage
  variant?: ChatAssistantMessageVariant
  showUsageSummary?: boolean
}

export interface ChatMessageActionsProps {
  copied?: boolean
  isReadonly?: boolean
  isStreaming?: boolean
  message: ChatMessage
  showEdit?: boolean
  showRetry?: boolean
  variant?: ChatMessageActionsVariant
}

export interface ChatMessageActionsEmits {
  copyMessage: [message: ChatMessage]
  editMessage: [message: ChatMessage]
  retryAssistantMessage: [message: ChatMessage]
  switchBranch: [messageId: string]
}

export interface ChatReasoningBlockProps {
  messageId: string
  text: string
  status: ChatMessage['status']
  elapsedMs?: number | null
  defaultExpanded?: boolean
  answerStarted?: boolean
}

export interface ChatToolCallTimelineProps {
  items: AssistantToolCallView[]
}

export interface ChatToolResultBlockProps {
  messageId: string
  phase: ChatMarkdownRenderPhase
  part: ChatMessage['parts'][number]
  index: number
}

export interface ChatUserMessageContentProps {
  message: Extract<ChatMessage, { role: 'user' }>
}
