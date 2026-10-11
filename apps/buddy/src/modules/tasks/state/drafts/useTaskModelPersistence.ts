import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { TaskModelSelection } from './typing'
import type { useChatDrafts } from './useChatDrafts'

interface TaskModelPersistenceOptions {
  activeConversationId: Readonly<Ref<string | null>>
  api: LocalChatApi['conversations']
  applyConversation: (conversation: LocalConversation) => void
  drafts: ReturnType<typeof useChatDrafts>
  onError: (error: unknown) => void
  selection: TaskModelSelection
}

export function useTaskModelPersistence(options: TaskModelPersistenceOptions) {
  let conversationModelPersistenceRevision = 0
  let conversationModelPersistenceQueue = Promise.resolve(true)

  function persistConversationModelSelection(
    conversationId: string | null,
    modelSelection: NonNullable<LocalConversation['modelSelection']> | null,
  ): Promise<boolean> {
    if (!conversationId || !modelSelection)
      return Promise.resolve(true)
    const revision = ++conversationModelPersistenceRevision
    const operation = async () => {
      try {
        const conversation = await options.api.setModelSelection(
          conversationId,
          modelSelection,
        )
        if (revision === conversationModelPersistenceRevision)
          options.applyConversation(conversation)
        return true
      }
      catch (error) {
        if (revision === conversationModelPersistenceRevision)
          options.onError(error)
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
    const conversationId = options.activeConversationId.value
    const persistDefault = options.selection.selectModel(value)
    if (options.selection.selectedModelId.value !== value) {
      await persistDefault
      return
    }
    const modelSelection = options.selection.currentSelection()
    options.drafts.setModelSelection(modelSelection)
    await Promise.all([persistDefault, persistConversationModelSelection(conversationId, modelSelection)])
  }

  async function setChatEffort(value: Parameters<TaskModelSelection['setSelectedEffort']>[0]) {
    const conversationId = options.activeConversationId.value
    const persistDefault = options.selection.setSelectedEffort(value)
    const modelSelection = options.selection.currentSelection()
    options.drafts.setModelSelection(modelSelection)
    await Promise.all([persistDefault, persistConversationModelSelection(conversationId, modelSelection)])
  }

  async function setChatServiceTier(
    value: Parameters<TaskModelSelection['setSelectedServiceTier']>[0],
  ) {
    const conversationId = options.activeConversationId.value
    options.selection.setSelectedServiceTier(value)
    options.drafts.setModelSelection(options.selection.currentSelection())
    await persistConversationModelSelection(conversationId, options.selection.currentSelection())
  }

  return { selectChatModel, setChatEffort, setChatServiceTier, flushModelSelection: () => conversationModelPersistenceQueue }
}
