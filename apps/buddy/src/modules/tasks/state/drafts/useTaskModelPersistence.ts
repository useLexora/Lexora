import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { TaskModelSelection } from './typing'
import type { useChatDrafts } from './useChatDrafts'
import { computed, shallowReactive } from 'vue'

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

type ModelPersistenceResult = { saved: true } | { saved: false, error: unknown }

interface ModelPersistenceState {
  pending: boolean
  promise: Promise<ModelPersistenceResult>
}

export function useTaskModelPersistence(options: TaskModelPersistenceOptions) {
  const persistence = shallowReactive(new Map<string, ModelPersistenceState>())
  const currentTarget = computed(() => {
    const conversationId = options.activeConversationId.value
    const target = options.target?.()
    return {
      conversationId,
      target: target ? { ...target } : undefined,
      key: JSON.stringify([conversationId ? 'conversation' : 'draft', conversationId ?? options.drafts.draftId.value, target?.actorId ?? null]),
    }
  })
  const isUpdating = computed(() => persistence.get(currentTarget.value.key)?.pending ?? false)

  function persistModelSelection(
    captured: typeof currentTarget.value,
    persistDefault: Promise<boolean> = Promise.resolve(true),
  ): Promise<ModelPersistenceResult> {
    const { conversationId, target, key } = captured
    const modelSelection = options.selection.currentSelection()
    const persistConversation = options.persistTarget?.() !== false
    options.drafts.setModelSelection(modelSelection)
    const operation = async () => {
      try {
        const [conversationResult, defaultResult] = await Promise.allSettled([
          conversationId && modelSelection && persistConversation
            ? options.api.setModelSelection(conversationId, modelSelection, ...target ? [target] as const : [])
            : Promise.resolve(null),
          persistDefault,
        ])
        if (conversationResult.status === 'rejected')
          throw conversationResult.reason
        if (defaultResult.status === 'rejected')
          throw defaultResult.reason
        const conversation = conversationResult.value
        if (conversation && key === currentTarget.value.key) {
          options.applyConversation(conversation)
          await options.onPersisted?.()
        }
        return { saved: true } as const
      }
      catch (error) {
        if (key === currentTarget.value.key) {
          options.onError(error)
          await options.onPersisted?.()
        }
        return { saved: false, error } as const
      }
    }
    const state: ModelPersistenceState = {
      pending: true,
      promise: Promise.resolve().then(operation).finally(() => {
        persistence.set(key, { ...state, pending: false })
      }),
    }
    persistence.set(key, state)
    return state.promise
  }

  async function selectChatModel(value: string) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const target = currentTarget.value
    const persistDefault = selection.selectModel(value)
    if (selection.selectedModelId.value !== value) {
      await persistDefault
      return
    }
    await persistModelSelection(target, persistDefault)
  }

  async function setChatEffort(value: Parameters<TaskModelSelection['setSelectedEffort']>[0]) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const target = currentTarget.value
    const persistDefault = selection.setSelectedEffort(value)
    await persistModelSelection(target, persistDefault)
  }

  async function setChatServiceTier(
    value: Parameters<TaskModelSelection['setSelectedServiceTier']>[0],
  ) {
    if (isUpdating.value || options.canUpdate?.() === false)
      return
    const selection = options.selection
    const target = currentTarget.value
    selection.setSelectedServiceTier(value)
    await persistModelSelection(target)
  }

  async function flushModelSelection() {
    const { key } = currentTarget.value
    const state = persistence.get(key)
    if (!state)
      return true
    const result = await state.promise
    if (!result.saved && key === currentTarget.value.key)
      options.onError(result.error)
    return result.saved
  }

  return { isUpdating, selectChatModel, setChatEffort, setChatServiceTier, flushModelSelection }
}
