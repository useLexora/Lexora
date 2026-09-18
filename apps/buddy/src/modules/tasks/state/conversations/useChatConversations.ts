import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation, LocalMessage } from '@buddy-shared/conversation/conversationApi'

import type { ChatSession } from '@/modules/tasks/state/conversations/useChatSession'
import type { ChatRunSync } from '@/modules/tasks/state/runs/typing'
import type { TaskIndexData } from '@/modules/tasks/state/task-index/useTaskIndexData'
import { computed, onScopeDispose, readonly, shallowRef } from 'vue'

interface UseChatConversationsOptions {
  api: { conversations: Pick<LocalChatApi['conversations'], 'get' | 'listBranches' | 'listMessages'> }
  taskIndexData: Pick<TaskIndexData, 'applyConversation' | 'conversations' | 'refreshIndex'>
  clearError: () => void
  onError: (error: unknown) => void
  persistWorkspaceState: () => Promise<boolean>
  runSync: Pick<ChatRunSync, 'clearConversationState' | 'refreshActiveConversation'>
  restoreConversationModelSelection: (
    value: LocalConversation['modelSelection'],
  ) => void
  selectDefaultModel: () => void
  session: Pick<ChatSession, | 'activateConversation'
  | 'activateDraft'
  | 'activeBranchId'
  | 'activeConversationId'
  | 'generation'
  | 'isCurrent'
  | 'replaceBranches'>
}

export function useChatConversations(options: UseChatConversationsOptions) {
  let opening = 0
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const directlyOpenedConversation = shallowRef<LocalConversation | null>(null)
  const activeConversation = computed(() => (
    directlyOpenedConversation.value?.id === options.session.activeConversationId.value
      ? directlyOpenedConversation.value
      : options.taskIndexData.conversations.value.find(
        conversation => conversation.id === options.session.activeConversationId.value,
      ) ?? null
  ))

  async function refreshBranches() {
    const conversationId = options.session.activeConversationId.value
    const navigationVersion = options.session.generation()
    if (!conversationId) {
      options.session.replaceBranches([])
      return
    }
    const branches = await options.api.conversations.listBranches(conversationId)
    if (options.session.isCurrent(navigationVersion, conversationId))
      options.session.replaceBranches(branches)
  }

  async function openConversation(conversationId: string, signal?: AbortSignal) {
    const request = ++opening
    const generation = options.session.generation()
    const sourceId = options.session.activeConversationId.value
    const isCurrent = () => !disposed && !signal?.aborted && request === opening
    const canActivate = () => isCurrent() && options.session.isCurrent(generation)
      && sourceId === options.session.activeConversationId.value
    if (!isCurrent())
      return
    const indexed = options.taskIndexData.conversations.value.find(
      item => item.id === conversationId,
    )
    const conversation = indexed ?? await options.api.conversations.get(conversationId).catch(
      (error) => {
        if (canActivate())
          options.onError(error)
        return null
      },
    )
    if (!conversation || !canActivate())
      return
    directlyOpenedConversation.value = indexed ? null : conversation
    options.session.activateConversation(conversation)
    options.restoreConversationModelSelection(conversation.modelSelection)
    await Promise.all([
      refreshBranches(),
      options.runSync.refreshActiveConversation(),
      options.persistWorkspaceState(),
    ])
  }

  async function activateGlobalDraft() {
    activateDraftScope(null)
    options.selectDefaultModel()
    await options.persistWorkspaceState()
  }

  function applyConversation(conversation: LocalConversation) {
    options.taskIndexData.applyConversation(conversation)
    if (directlyOpenedConversation.value?.id === conversation.id)
      directlyOpenedConversation.value = conversation
  }

  async function listActiveConversationMessages() {
    const conversationId = options.session.activeConversationId.value
    const branchId = options.session.activeBranchId.value
    if (!conversationId || !branchId)
      return []

    try {
      let cursor: string | undefined
      let messages: ReadonlyArray<LocalMessage> = []
      do {
        const page = await options.api.conversations.listMessages({
          branchId,
          conversationId,
          cursor,
          limit: 500,
        })
        if (
          conversationId !== options.session.activeConversationId.value
          || branchId !== options.session.activeBranchId.value
        ) {
          return []
        }
        messages = [...page.items, ...messages]
        cursor = page.nextCursor ?? undefined
      } while (cursor)

      return messages
    }
    catch (error) {
      options.onError(error)
      return []
    }
  }

  function activateDraftScope(spaceId: string | null) {
    options.session.activateDraft(spaceId)
    directlyOpenedConversation.value = null
    options.runSync.clearConversationState()
    options.clearError()
  }

  return {
    activateDraftScope,
    activeConversation: readonly(activeConversation),
    activateGlobalDraft,
    applyConversation,
    listActiveConversationMessages,
    openConversation,
    refreshBranches,
  }
}
