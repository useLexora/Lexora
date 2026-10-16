import { useGlobalChatEngine } from './useGlobalChatEngine'

export function useChatModelSettings() {
  return useGlobalChatEngine().model
}
