import type { ChatMessage } from '@/apis/chat'

export interface DocsChatMessagesProps {
  messages: ChatMessage[]
  sessionId: string | null
  isReadonly?: boolean
  isStreaming?: boolean
  isMessageCopied?: (message: ChatMessage) => boolean
}

export interface DocsChatMessagesEmits {
  copyMessage: [message: ChatMessage]
  retryAssistantMessage: [message: ChatMessage]
  switchBranch: [messageId: string]
}
