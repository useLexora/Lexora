import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'

interface ConversationMcpPanelHandle {
  open: () => void
}

export const CONVERSATION_MCP_PANEL_KEY: InjectionKey<ConversationMcpPanelHandle> = Symbol('conversationMcpPanel')

export function provideConversationMcpPanel(handle: ConversationMcpPanelHandle): void {
  provide(CONVERSATION_MCP_PANEL_KEY, handle)
}

export function useConversationMcpPanel(): ConversationMcpPanelHandle | null {
  return inject(CONVERSATION_MCP_PANEL_KEY, null)
}
