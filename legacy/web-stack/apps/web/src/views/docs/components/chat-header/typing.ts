import type { ChatSessionSummary } from '@/apis/chat'

export interface DocsChatHeaderProps {
  activeSessionId: string | null
  hasActiveSession: boolean
  isDeleting: boolean
  isLoadingSessions: boolean
  sessions: ChatSessionSummary[]
  title: string
}

export interface DocsChatHeaderEmits {
  deleteSession: []
  loadHistory: []
  newSession: []
  renameSession: []
  selectHistory: [sessionId: string]
}
