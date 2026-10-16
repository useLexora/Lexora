import type { ChatSessionSummary } from '@/apis/chat'

export interface ChatWorkspaceLayoutProps {
  agentProfile: ChatSessionSummary['agentProfile'] | null
  isAgentSettingsOpen: boolean
  isNewChatRoute: boolean
  isReadonlySession: boolean
  isSidebarCollapsed: boolean
}

export interface ChatWorkspaceLayoutEmits {
  collapseSidebar: []
  closeAgentSettings: []
  defaultModelUpdated: []
  showSidebar: []
}
