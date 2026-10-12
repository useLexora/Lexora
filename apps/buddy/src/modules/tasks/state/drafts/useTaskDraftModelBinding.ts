import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { ChatDraftSnapshot, TaskModelSelection } from './typing'
import { watch } from 'vue'

type ModelSelection = LocalConversation['modelSelection']

interface TaskDraftModelBindingOptions {
  drafts: {
    modelSelection: Readonly<Ref<ModelSelection>>
    targetKey: Readonly<Ref<string>>
    snapshot: (targetKey: string) => ChatDraftSnapshot
    setModelSelection: (value: ModelSelection) => void
  }
  conversationModel: () => ModelSelection
  isModelCatalogReady: Readonly<Ref<boolean>>
  selection: TaskModelSelection
}

export function useTaskDraftModelBinding(options: TaskDraftModelBindingOptions) {
  const stopScopeSync = watch(
    () => [options.drafts.targetKey.value, options.drafts.modelSelection.value] as const,
    () => restoreScope(options.conversationModel()),
    { flush: 'sync' },
  )
  const stopCatalogInitialization = watch(options.isModelCatalogReady, (ready) => {
    if (!ready)
      return
    const current = options.drafts.snapshot(options.drafts.targetKey.value)
    if (current.revision !== null && current.modelSelection === null)
      restoreScope(options.conversationModel())
  }, { flush: 'sync' })

  function restoreScope(fallback: ModelSelection = null) {
    const current = options.drafts.snapshot(options.drafts.targetKey.value)
    options.selection.restoreConversationModelSelection(current.modelSelection ?? fallback ?? options.conversationModel())
  }

  function restoreOpenedDraft(targetKey: string) {
    if (targetKey === options.drafts.targetKey.value)
      restoreScope(options.conversationModel())
  }

  return {
    dispose() {
      stopScopeSync()
      stopCatalogInitialization()
    },
    initialModelSelection: (targetKey: string) => options.drafts.snapshot(targetKey).modelSelection,
    restoreOpenedDraft,
    restoreScope,
  }
}
