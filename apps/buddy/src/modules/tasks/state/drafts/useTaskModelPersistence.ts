import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { TaskModelSelection } from './typing'
import type { useChatDrafts } from './useChatDrafts'
import { readonly, shallowRef } from 'vue'

interface TaskModelPersistenceOptions {
  target?: () => { actorId?: string }
  canUpdate?: () => boolean
  persistTarget?: () => boolean
  onPersisted?: () => Promise<void>
  activeConversationId: Readonly<Ref<string | null>>
  api: Pick<LocalChatApi['conversations'], 'setModelSelection'>
  applyConversation: (conversation: LocalConversation) => void
  drafts: ReturnType<typeof useChatDrafts>
  onError: (error: unknown) => void
  selection: TaskModelSelection
}

export function useTaskModelPersistence(options: TaskModelPersistenceOptions) {
  const isUpdating = shallowRef(false)
  let conversationModelPersistenceRevision = 0
  let conversationModelPersistenceQueue = Promise.resolve(true)

  function persistConversationModelSelection(
    conversationId: string | null,
    modelSelection: NonNullable<LocalConversation['modelSelection']> | null,
    target?: { actorId?: string },
  ): Promise<boolean> {
    if (!conversationId || !modelSelection || options.persistTarget?.() === false)
      return Promise.resolve(true)
    const revision = ++conversationModelPersistenceRevision
    const operation = async () => {
      try {
        const conversation = await options.api.setModelSelection(
          conversationId,
          modelSelection,
          ...target ? [target] as const : [],
        )
        if (revision === conversationModelPersistenceRevision) {
          options.applyConversation(conversation)
          await options.onPersisted?.()
        }
        return true
      }
      catch (error) {
        if (revision === conversationModelPersistenceRevision)
          options.onError(error)
        await options.onPersisted?.()
        return false
      }
    }
    conversationModelPersistenceQueue = conversationModelPersistenceQueue.then(
      operation,
      operation,
    )
    return conversationModelPersistenceQueue
  }

  async function selectChatModel(value: string) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const conversationId = options.activeConversationId.value
    const target = options.target?.()
    const persistDefault = selection.selectModel(value)
    if (selection.selectedModelId.value !== value) {
      await persistDefault
      return
    }
    const modelSelection = selection.currentSelection()
    options.drafts.setModelSelection(modelSelection)
    isUpdating.value = true
    try {
      await Promise.all([persistDefault, persistConversationModelSelection(conversationId, modelSelection, target)])
    }
    finally {
      isUpdating.value = false
    }
  }

  async function setChatEffort(value: Parameters<TaskModelSelection['setSelectedEffort']>[0]) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const conversationId = options.activeConversationId.value
    const target = options.target?.()
    const persistDefault = selection.setSelectedEffort(value)
    const modelSelection = selection.currentSelection()
    options.drafts.setModelSelection(modelSelection)
    isUpdating.value = true
    try {
      await Promise.all([persistDefault, persistConversationModelSelection(conversationId, modelSelection, target)])
    }
    finally {
      isUpdating.value = false
    }
  }

  async function setChatServiceTier(
    value: Parameters<TaskModelSelection['setSelectedServiceTier']>[0],
  ) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const conversationId = options.activeConversationId.value
    const target = options.target?.()
    selection.setSelectedServiceTier(value)
    options.drafts.setModelSelection(selection.currentSelection())
    isUpdating.value = true
    try {
      await persistConversationModelSelection(conversationId, selection.currentSelection(), target)
    }
    finally {
      isUpdating.value = false
    }
  }

  return { isUpdating: readonly(isUpdating), selectChatModel, setChatEffort, setChatServiceTier, flushModelSelection: () => conversationModelPersistenceQueue }
}
