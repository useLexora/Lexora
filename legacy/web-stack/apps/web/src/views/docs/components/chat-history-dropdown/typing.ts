import type { ChatSessionSummary } from '@/apis/chat'

export interface DocsChatHistoryDropdownProps {
  activeSessionId: string | null
  isLoading: boolean
  sessions: ChatSessionSummary[]
  title: string
}

export interface DocsChatHistoryDropdownEmits {
  load: []
  select: [sessionId: string]
}
