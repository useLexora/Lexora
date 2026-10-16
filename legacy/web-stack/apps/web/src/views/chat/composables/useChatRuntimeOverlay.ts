import { useGlobalChatEngine } from './useGlobalChatEngine'

export type { ChatRuntimeOverlay } from '@/composables/chat/createChatRuntimeOverlay'

export function useChatRuntimeOverlay() {
  return useGlobalChatEngine().overlay
}
