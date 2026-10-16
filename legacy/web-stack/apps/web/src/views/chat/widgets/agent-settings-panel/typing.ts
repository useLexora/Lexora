import type { AgentMemoryDocumentId } from '@/apis/agent-memory'
import type { ChatSessionSummary } from '@/apis/chat'

export interface ChatAgentSettingsPanelProps {
  agentProfile: ChatSessionSummary['agentProfile'] | null
}

export interface ChatAgentSettingsPanelEmits {
  close: []
  defaultModelUpdated: []
}

export interface AgentMemoryDocumentView {
  id: AgentMemoryDocumentId
  name: string
  sizeText: string
  updatedAtText: string
  summary: string
  content: string
}
