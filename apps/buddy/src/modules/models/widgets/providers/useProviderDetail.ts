import type { LocalCustomProviderModel } from '@buddy-shared/providers/providerApi'
import type { ModelProvidersStore } from '../../state/typing'
import type { ModelParameterActions, ProviderConnectionActions } from './typing'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { desktopProviderApiOptions } from '../../model/desktopProviderApiOptions'

export function useProviderDetail(providerSettings: () => ModelProvidersStore, providerId: () => string) {
  let generation = 0
  const provider = computed(() => providerSettings().providers.value.find(item => item.id === providerId()) ?? null)
  const models = computed(() => providerSettings().registeredModels.value.filter(
    model => model.providerId === providerId(),
  ))
  const savingManualModel = shallowRef(false)
  const manualFormKey = shallowRef(0)
  const showManualModelDialog = shallowRef(false)
  const selectedModelId = shallowRef<string | null>(null)
  const selectedModel = computed(() => models.value.find(model => model.modelId === selectedModelId.value) ?? null)
  const modelActions = computed<ModelParameterActions | null>(() => {
    const model = selectedModel.value
    if (!model)
      return null
    return {
      saveCapabilities: capabilities => providerSettings().setModelCapabilities(model.providerId, model.modelId, capabilities),
      selectCatalogSource: source => providerSettings().setModelCatalogSource(model.providerId, model.modelId, source),
      saveManualModel: input => providerSettings().upsertManualModel(model.providerId, input),
      saveParameters: parameters => providerSettings().setModelParameters(model.providerId, model.modelId, parameters),
      restoreParameters: () => providerSettings().restoreModelSourceParameters(model.providerId, model.modelId),
      acknowledgeSourceUpdate: () => providerSettings().acknowledgeModelSourceUpdate(model.providerId, model.modelId),
    }
  })
  const connectionActions: ProviderConnectionActions = {
    clearError: () => providerSettings().clearModelProviderError(),
    rename: (id, displayName, headers) => providerSettings().renameProvider(id, displayName, headers),
    save: input => providerSettings().upsertCustomProvider(input),
  }
  const showModelDetailDialog = shallowRef(false)
  const showConnectionDialog = shallowRef(false)
  const connectionSummary = computed(() => {
    const value = provider.value
    if (!value?.custom)
      return value?.displayName ?? ''
    const api = desktopProviderApiOptions.find(option => option.value === value.api)?.label ?? value.api
    return [api, value.baseUrl].filter(Boolean).join(' · ')
  })

  watch([providerSettings, providerId], () => {
    generation += 1
    manualFormKey.value += 1
    savingManualModel.value = false
    selectedModelId.value = null
    showManualModelDialog.value = false
    showModelDetailDialog.value = false
    showConnectionDialog.value = false
  }, { flush: 'sync' })

  onScopeDispose(() => {
    generation += 1
  })

  async function saveManualModel(model: LocalCustomProviderModel) {
    if (savingManualModel.value)
      return
    const requestGeneration = generation
    const formKey = manualFormKey.value
    savingManualModel.value = true
    try {
      const saved = await providerSettings().upsertManualModel(providerId(), model)
      if (requestGeneration !== generation || formKey !== manualFormKey.value)
        return
      if (saved)
        showManualModelDialog.value = false
    }
    finally {
      if (requestGeneration === generation && formKey === manualFormKey.value)
        savingManualModel.value = false
    }
  }

  function openManualModelDialog() {
    manualFormKey.value += 1
    savingManualModel.value = false
    showManualModelDialog.value = true
  }

  function openModelDetail(modelId: string) {
    selectedModelId.value = modelId
    showModelDetailDialog.value = true
  }

  function formatTokens(value: number): string {
    return new Intl.NumberFormat(providerSettings().language.value).format(value)
  }

  async function removeUnavailableModel(modelId: string) {
    await providerSettings().removeModel(providerId(), modelId)
  }

  return {
    provider,
    models,
    selectedModel,
    modelActions,
    connectionActions,
    connectionSummary,
    savingManualModel,
    manualFormKey,
    showManualModelDialog,
    showModelDetailDialog,
    showConnectionDialog,
    saveManualModel,
    openManualModelDialog,
    openModelDetail,
    formatTokens,
    removeUnavailableModel,
  }
}
