import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import { onScopeDispose, readonly, shallowRef } from 'vue'
import { useTaskHistory } from './useTaskHistory'

interface UseTaskIndexDataOptions {
  api: {
    conversations: Pick<LexoraDesktopApi['localChat']['conversations'], 'listHistory' | 'getHistoryEntries'>
    spaces: Pick<LexoraDesktopApi['localChat']['spaces'], 'list'>
  }
  onError?: (error: unknown) => void
}

export function useTaskIndexData(options: UseTaskIndexDataOptions) {
  const spaces = shallowRef<ReadonlyArray<LocalSpace>>([])
  const history = useTaskHistory(options.api.conversations)
  let spaceListGeneration = 0
  let disposed = false
  let initialized = false
  let initialization: Promise<void> | null = null
  function dispose() {
    disposed = true
    history.dispose()
    spaceListGeneration += 1
  }
  onScopeDispose(dispose)

  async function refreshIndex() {
    if (disposed)
      return
    await Promise.all([refreshSpaces(), history.refreshConversations()])
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

  function applySpace(space: LocalSpace) {
    replaceSpaces([...spaces.value.filter(item => item.id !== space.id), space])
  }

  function replaceSpaces(value: ReadonlyArray<LocalSpace>) {
    spaceListGeneration += 1
    spaces.value = value
  }

  function applyConversation(conversation: LocalConversation) {
    void history.applyConversation(conversation).catch(error => options.onError?.(error))
  }

  function updateConversationBranch(conversationId: string, branchId: string, updatedAt: string) {
    void history.updateConversationBranch(conversationId, branchId, updatedAt).catch(error => options.onError?.(error))
  }

  return {
    ...history,
    dispose,
    initialize,
    applyConversation,
    applySpace,
    spaces: readonly(spaces),
    refreshIndex,
    refreshSpaces,
    replaceSpaces,
    updateConversationBranch,
  }
}

export type TaskIndexData = ReturnType<typeof useTaskIndexData>
