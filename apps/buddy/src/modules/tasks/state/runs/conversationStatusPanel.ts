import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'

export interface ConversationStatusPanelHandle {
  open: () => void
}

export const CONVERSATION_STATUS_PANEL_KEY: InjectionKey<ConversationStatusPanelHandle> = Symbol('conversationStatusPanel')

export function provideConversationStatusPanel(handle: ConversationStatusPanelHandle): void {
  provide(CONVERSATION_STATUS_PANEL_KEY, handle)
}

export function useConversationStatusPanel(): ConversationStatusPanelHandle | null {
  return inject(CONVERSATION_STATUS_PANEL_KEY, null)
}
