import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversation, LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import { onScopeDispose, readonly, shallowRef } from 'vue'

interface UseTaskIndexDataOptions {
  api: {
    conversations: Pick<LexoraDesktopApi['localChat']['conversations'], 'list'>
    spaces: Pick<LexoraDesktopApi['localChat']['spaces'], 'list'>
  }
}

export function useTaskIndexData(options: UseTaskIndexDataOptions) {
  const spaces = shallowRef<ReadonlyArray<LocalSpace>>([])
  const conversations = shallowRef<ReadonlyArray<LocalConversationSummary>>([])
  let conversationListGeneration = 0
  let spaceListGeneration = 0
  let disposed = false
  let initialized = false
  let initialization: Promise<void> | null = null
  onScopeDispose(() => {
    disposed = true
    conversationListGeneration += 1
    spaceListGeneration += 1
  })

  async function refreshIndex() {
    if (disposed)
      return
    await Promise.all([refreshSpaces(), refreshConversations()])
    initialized = true
  }

  function initialize(): Promise<void> {
    if (initialized)
      return Promise.resolve()
    initialization ??= refreshIndex().finally(() => initialization = null)
    return initialization
  }

  async function refreshSpaces() {
    const generation = ++spaceListGeneration
    try {
      const nextSpaces = await options.api.spaces.list()
      if (!disposed && generation === spaceListGeneration)
        spaces.value = nextSpaces
    }
    catch (error) {
      if (!disposed && generation === spaceListGeneration)
        throw error
    }
  }

  async function refreshConversations() {
    if (disposed)
      return
    const generation = ++conversationListGeneration
    try {
      const nextConversations = await options.api.conversations.list()
      if (!disposed && generation === conversationListGeneration)
        conversations.value = nextConversations
    }
    catch (error) {
      if (!disposed && generation === conversationListGeneration)
        throw error
    }
  }

  function applySpace(space: LocalSpace) {
    replaceSpaces([...spaces.value.filter(item => item.id !== space.id), space])
  }

  function replaceSpaces(value: ReadonlyArray<LocalSpace>) {
    spaceListGeneration += 1
    spaces.value = value
  }

  function applyConversation(conversation: LocalConversation) {
    const existing = conversations.value.find(item => item.id === conversation.id)
    if (!existing) {
      void refreshConversations().catch(() => {})
      return
    }
    conversationListGeneration += 1
    conversations.value = conversations.value.map(item => item.id === conversation.id
      ? { ...item, ...conversation }
      : item)
  }

  function updateConversationBranch(
    conversationId: string,
    branchId: string,
    updatedAt: string,
  ) {
    conversationListGeneration += 1
    conversations.value = conversations.value.map(conversation => conversation.id === conversationId
      ? { ...conversation, activeBranchId: branchId, updatedAt }
      : conversation)
  }

  return {
    initialize,
    applyConversation,
    applySpace,
    conversations: readonly(conversations),
    spaces: readonly(spaces),
    refreshIndex,
    refreshConversations,
    replaceSpaces,
    updateConversationBranch,
  }
}

export type TaskIndexData = ReturnType<typeof useTaskIndexData>
