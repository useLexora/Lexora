import { useGlobalChatEngine } from './useGlobalChatEngine'

export type {
  ChatStreamController,
  SendChatComposerMessageInput,
} from '@/composables/chat/createChatStreamController'

export function useChatStream() {
  return useGlobalChatEngine().stream
}
