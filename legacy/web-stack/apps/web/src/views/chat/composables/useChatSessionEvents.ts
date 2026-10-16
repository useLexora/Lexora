import { useGlobalChatEngine } from './useGlobalChatEngine'

export type { ChatSessionEvents } from '@/composables/chat/createChatSessionEvents'

export function useChatSessionEvents() {
  return useGlobalChatEngine().events
}
