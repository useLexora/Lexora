import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { TaskModelSelection } from './typing'
import type { ModelProvidersStore } from '@/modules/models'
import { computed, readonly, shallowRef } from 'vue'
import { modelKey, resolveConcreteEffort } from '@/modules/models'

type ConversationModelSelection = LocalConversation['modelSelection']

export function useTaskModelSelection(catalog: ModelProvidersStore, options: { rememberSelection?: boolean } = {}): TaskModelSelection {
  const override = shallowRef<ConversationModelSelection>(null)
  const configuration = computed<ConversationModelSelection>(() => {
    if (override.value)
      return override.value
    const model = catalog.models.value.find(item => modelKey(item) === catalog.defaultModelId.value)
    return model
      ? {
          modelId: model.modelId,
          providerId: model.providerId,
          reasoning: resolveConcreteEffort(model, catalog.defaultEffort.value),
          serviceTier: null,
        }
      : null
  })
  const selectedModelId = computed(() => configuration.value ? modelKey(configuration.value) : null)
  const selectedEffort = computed(() => configuration.value?.reasoning ?? null)
  const selectedServiceTier = computed(() => configuration.value?.serviceTier ?? null)
  const selectedModel = computed(() => catalog.models.value.find(model => modelKey(model) === selectedModelId.value) ?? null)
  const selectedModelOption = computed(() => catalog.registeredModels.value.find(model => modelKey(model) === selectedModelId.value) ?? null)

  function selectDefaultModel() {
    override.value = null
  }

  function restoreConversationModelSelection(value: ConversationModelSelection) {
    override.value = value ? { ...value } : null
  }

  async function selectModel(value: string): Promise<boolean> {
    const model = catalog.models.value.find(item => modelKey(item) === value)
    if (!model)
      return false
    override.value = {
      modelId: model.modelId,
      providerId: model.providerId,
      reasoning: resolveConcreteEffort(model, null),
      serviceTier: null,
    }
    return rememberSelection()
  }

  async function setSelectedEffort(value: BuddyThinkingLevel | null): Promise<boolean> {
    const model = selectedModel.value
    if (!model || !configuration.value)
      return false
    override.value = { ...configuration.value, reasoning: resolveConcreteEffort(model, value) }
    return rememberSelection()
  }

  function setSelectedServiceTier(value: BuddyServiceTier | null) {
    if (configuration.value)
      override.value = { ...configuration.value, serviceTier: value }
  }

  function rememberSelection(): Promise<boolean> {
    if (options.rememberSelection === false)
      return Promise.resolve(true)
    const value = configuration.value
    return value
      ? catalog.rememberModelSelection({ modelId: value.modelId, providerId: value.providerId, reasoning: value.reasoning })
      : Promise.resolve(false)
  }

  return {
    currentSelection: () => configuration.value,
    dispose: () => {},
    restoreConversationModelSelection,
    selectDefaultModel,
    selectedEffort: readonly(selectedEffort),
    selectedModel: readonly(selectedModel),
    selectedModelId: readonly(selectedModelId),
    selectedModelOption: readonly(selectedModelOption),
    selectedServiceTier: readonly(selectedServiceTier),
    selectModel,
    setSelectedEffort,
    setSelectedServiceTier,
  }
}
