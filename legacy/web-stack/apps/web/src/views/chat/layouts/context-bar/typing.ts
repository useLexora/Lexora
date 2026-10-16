import type { ChatConversationUsageView } from '../../utils/chat-usage-display'

export interface ChatContextBarProps {
  conversationUsage: ChatConversationUsageView
  isAgentSettingsOpen: boolean
}

export interface ChatContextBarEmits {
  toggleAgentSettings: []
  newChat: []
}
