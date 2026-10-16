import { useGlobalChatEngine } from './useGlobalChatEngine'

export type {
  ActiveChatSession,
  ChatSession,
  ChatSessionController,
} from '@/composables/chat/createChatSessionController'

export function useChatSessions() {
  return useGlobalChatEngine().sessions
}
