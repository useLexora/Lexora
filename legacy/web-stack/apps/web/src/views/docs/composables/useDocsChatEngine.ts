import { CHAT_SESSION_ORIGIN } from '@haohaoxue/lexora-contracts/chat/constants'
import { createSharedComposable } from '@vueuse/core'
import { createChatEngine } from '@/composables/chat/createChatEngine'
import { useWorkspaceStore } from '@/stores/workspace'

export const useDocsChatEngine = createSharedComposable(() => {
  const workspaceStore = useWorkspaceStore()

  return createChatEngine(CHAT_SESSION_ORIGIN.DOCS, {
    getWorkspaceId: () => workspaceStore.personalWorkspace?.id,
  })
})

export type DocsChatEngine = ReturnType<typeof useDocsChatEngine>
