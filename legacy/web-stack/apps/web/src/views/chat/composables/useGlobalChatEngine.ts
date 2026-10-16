import { CHAT_SESSION_ORIGIN } from '@haohaoxue/lexora-contracts/chat/constants'
import { createSharedComposable } from '@vueuse/core'
import { createChatEngine } from '@/composables/chat/createChatEngine'
import { useUiStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useChatRouteState } from './useChatRouteState'

export const useGlobalChatEngine = createSharedComposable(() => {
  const uiStore = useUiStore()
  const workspaceStore = useWorkspaceStore()

  return createChatEngine(CHAT_SESSION_ORIGIN.GLOBAL, {
    getWorkspaceId: () => workspaceStore.personalWorkspace?.id,
    // 延迟解析，避免 useChatRouteState 与引擎初始化互相依赖。
    onSessionCreated: sessionId => useChatRouteState().navigateToSession(sessionId),
    persistence: {
      rememberActive: uiStore.setLastActiveChatSessionId,
      forgetActive: uiStore.clearLastActiveChatSessionId,
    },
  })
})
