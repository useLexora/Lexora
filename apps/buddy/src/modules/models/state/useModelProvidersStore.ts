import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type {
  BuddyThinkingLevel,
} from '@buddy-shared/conversation/modelSelection'
import type { LocalBuiltinProviderPreset, LocalCustomProvider, LocalDefaultModel, LocalModelSnapshot, LocalProvider, LocalProviderAuthChallenge, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { ShallowRef } from 'vue'
import type { ModelProvidersStore } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { computed, readonly, shallowRef } from 'vue'
import { isProviderLoginCancelled, resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { modelKey, resolveConcreteEffort } from '../model/modelSelection'

interface UseModelProvidersStoreOptions {
  api: LexoraDesktopApi['localChat']['providers']
  language: Readonly<ShallowRef<BuddyLocale>>
  onCatalogChanged?: () => void
}

export function useModelProvidersStore(options: UseModelProvidersStoreOptions): ModelProvidersStore {
  const builtinPresets = shallowRef<ReadonlyArray<LocalBuiltinProviderPreset>>([])
  const providers = shallowRef<ReadonlyArray<LocalProvider>>([])
  const registeredModels = shallowRef<ReadonlyArray<LocalRuntimeModelOption>>([])
  const authChallenge = shallowRef<LocalProviderAuthChallenge | null>(null)
  const defaultModelSelection = shallowRef<LocalDefaultModel | null>(null)
  const modelSnapshot = shallowRef<LocalModelSnapshot | null>(null)
  const isLoadingModelCatalog = shallowRef(false)
  const isRefreshingModelSnapshot = shallowRef(false)
  const isAuthenticating = shallowRef(false)
  const mutatingProviderId = shallowRef<string | null>(null)
  const syncingProviderId = shallowRef<string | null>(null)
  const modelProviderError = shallowRef<string | null>(null)

  const models = computed(() => filterAvailableModels(providers.value, registeredModels.value))
  const defaultModelId = computed(() => defaultModelSelection.value
    ? modelKey(defaultModelSelection.value)
    : null)
  const defaultEffort = computed(() => defaultModelSelection.value?.reasoning ?? null)
  let catalogRequest: Promise<boolean> | null = null
  let disposed = false
  let defaultModelPersistenceRevision = 0
  let persistDefaultModelQueue = Promise.resolve(true)
  const stopAuthChallenge = options.api.onAuthChallenge((challenge) => {
    if (!disposed)
      authChallenge.value = challenge
  })

  function loadModelCatalog(force = false): Promise<boolean> {
    if (disposed)
      return Promise.resolve(false)
    if (catalogRequest)
      return catalogRequest
    catalogRequest = fetchModelCatalog(force).finally(() => {
      catalogRequest = null
    })
    return catalogRequest
  }

  async function fetchModelCatalog(force: boolean): Promise<boolean> {
    if (!force && providers.value.length && registeredModels.value.length)
      return true
    isLoadingModelCatalog.value = true
    modelProviderError.value = null
    try {
      const snapshotRequest = typeof options.api.getModelSnapshot === 'function'
        ? options.api.getModelSnapshot().catch(() => null)
        : Promise.resolve(null)
      const [nextProviders, nextModels, nextDefaultModel, nextSnapshot, nextPresets] = await Promise.all([
        options.api.list(),
        options.api.listModels(),
        options.api.getDefaultModel(),
        snapshotRequest,
        options.api.listBuiltinPresets(),
      ])
      if (disposed)
        return false
      providers.value = nextProviders
      builtinPresets.value = nextPresets
      registeredModels.value = nextModels
      defaultModelSelection.value = nextDefaultModel
      modelSnapshot.value = nextSnapshot
      if (!nextDefaultModel && models.value[0]) {
        const model = models.value[0]
        const reasoning = resolveConcreteEffort(model, null)
        await persistDefaultModel({
          modelId: model.modelId,
          providerId: model.providerId,
          reasoning,
        })
      }
      if (!disposed)
        options.onCatalogChanged?.()
      return true
    }
    catch (error) {
      if (!disposed)
        modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
    finally {
      if (!disposed)
        isLoadingModelCatalog.value = false
    }
  }

  async function refreshAfterMutation(): Promise<boolean> {
    if (catalogRequest)
      await catalogRequest
    return loadModelCatalog(true)
  }

  async function loginProvider(providerId: string, authType: 'api_key' | 'oauth') {
    if (isAuthenticating.value)
      return false
    isAuthenticating.value = true
    modelProviderError.value = null
    try {
      await options.api.login(providerId, authType)
      if (authChallenge.value?.providerId === providerId)
        authChallenge.value = null
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      if (!isProviderLoginCancelled(error))
        modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
    finally {
      isAuthenticating.value = false
    }
  }

  async function respondToAuth(challengeId: string, value: string) {
    try {
      await options.api.respondToAuth(challengeId, value)
      if (authChallenge.value?.challengeId === challengeId)
        authChallenge.value = null
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
  }

  async function cancelAuth(challengeId: string) {
    await options.api.cancelAuth(challengeId).catch(() => {})
    if (authChallenge.value?.challengeId === challengeId)
      authChallenge.value = null
  }

  async function logoutProvider(providerId: string) {
    try {
      await options.api.logout(providerId)
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
  }

  async function createCustomProvider(provider: LocalCustomProvider) {
    modelProviderError.value = null
    try {
      const created = await options.api.createCustom(provider)
      await refreshAfterMutation()
      return created
    }
    catch (error) {
      if (error instanceof Error && parseLocalChatPublicError(error.message)?.code === 'PROVIDER_ID_CONFLICT')
        return 'conflict' as const
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return null
    }
  }

  async function upsertCustomProvider(provider: LocalCustomProvider) {
    try {
      await options.api.upsertCustom(provider)
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
  }

  async function addProvider(providerId: string) {
    if (mutatingProviderId.value)
      return null
    mutatingProviderId.value = providerId
    modelProviderError.value = null
    try {
      const provider = await options.api.add(providerId)
      if (disposed)
        return null
      providers.value = [...providers.value.filter(item => item.id !== provider.id), provider]
      await refreshAfterMutation()
      return provider
    }
    catch (error) {
      if (!disposed)
        modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return null
    }
    finally {
      mutatingProviderId.value = null
    }
  }

  async function renameProvider(providerId: string, displayName: string, requestHeaders?: readonly ProviderRequestHeader[]) {
    return mutateProvider(providerId, () => options.api.rename(providerId, displayName, requestHeaders))
  }

  async function clearProviderCredential(providerId: string) {
    return mutateProvider(providerId, () => options.api.clearCredential(providerId))
  }

  async function removeModel(providerId: string, modelId: string) {
    return mutateProvider(providerId, () => options.api.removeModel(providerId, modelId))
  }

  async function removeProvider(providerId: string) {
    return mutateProvider(providerId, () => options.api.remove(providerId))
  }

  async function setProviderEnabled(providerId: string, enabled: boolean) {
    return mutateProvider(providerId, () => options.api.setEnabled(providerId, enabled))
  }

  async function setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean) {
    return mutateProvider(providerId, () => options.api.setModelEnabled(providerId, modelId, enabled))
  }

  async function setModelCatalogSource(
    providerId: string,
    modelId: string,
    source: Parameters<LexoraDesktopApi['localChat']['providers']['setModelCatalogSource']>[2],
  ) {
    return mutateProvider(providerId, () => options.api.setModelCatalogSource(providerId, modelId, source))
  }

  async function setModelCapabilities(
    providerId: string,
    modelId: string,
    capabilities: Parameters<LexoraDesktopApi['localChat']['providers']['setModelCapabilities']>[2],
  ) {
    return mutateProvider(providerId, () => options.api.setModelCapabilities(providerId, modelId, capabilities))
  }

  async function setModelParameters(
    providerId: string,
    modelId: string,
    parameters: { contextWindow: number, maxTokens: number },
  ) {
    return mutateProvider(
      providerId,
      () => options.api.setModelParameters(providerId, modelId, parameters),
    )
  }

  async function acknowledgeModelSourceUpdate(providerId: string, modelId: string) {
    return mutateProvider(
      providerId,
      () => options.api.acknowledgeModelSourceUpdate(providerId, modelId),
    )
  }

  async function restoreModelSourceParameters(providerId: string, modelId: string) {
    return mutateProvider(
      providerId,
      () => options.api.restoreModelSourceParameters(providerId, modelId),
    )
  }

  async function upsertManualModel(
    providerId: string,
    model: Parameters<LexoraDesktopApi['localChat']['providers']['upsertManualModel']>[1],
  ) {
    return mutateProvider(providerId, () => options.api.upsertManualModel(providerId, model))
  }

  async function syncProviderModels(providerId: string) {
    if (syncingProviderId.value)
      return false
    syncingProviderId.value = providerId
    modelProviderError.value = null
    try {
      await options.api.syncModels(providerId)
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
    finally {
      syncingProviderId.value = null
    }
  }

  async function refreshModelSnapshot() {
    if (isRefreshingModelSnapshot.value)
      return false
    isRefreshingModelSnapshot.value = true
    modelProviderError.value = null
    try {
      modelSnapshot.value = await options.api.refreshModelSnapshot()
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
    finally {
      isRefreshingModelSnapshot.value = false
    }
  }

  async function openModelSnapshotDirectory() {
    try {
      await options.api.openModelSnapshotDirectory()
      return true
    }
    catch {
      return false
    }
  }

  async function mutateProvider(providerId: string, operation: () => Promise<unknown>) {
    if (mutatingProviderId.value)
      return false
    mutatingProviderId.value = providerId
    modelProviderError.value = null
    try {
      await operation()
      await refreshAfterMutation()
      return true
    }
    catch (error) {
      modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
      return false
    }
    finally {
      mutatingProviderId.value = null
    }
  }

  function clearModelProviderError() {
    modelProviderError.value = null
  }

  async function setDefaultModel(value: string | null) {
    const model = value ? registeredModels.value.find(item => modelKey(item) === value) : null
    if (value && !model)
      return false
    const current = defaultModelSelection.value
    const reasoning = model && current && modelKey(current) === value
      ? current.reasoning
      : null
    return persistDefaultModel(model
      ? { modelId: model.modelId, providerId: model.providerId, reasoning }
      : null)
  }

  async function setDefaultEffort(value: BuddyThinkingLevel | null) {
    const current = defaultModelSelection.value
    if (!current)
      return false
    const model = registeredModels.value.find(item => modelKey(item) === modelKey(current))
    if (!model || (value !== null && !model.reasoningOptions.includes(value)))
      return false
    return persistDefaultModel({ ...current, reasoning: value })
  }

  async function persistDefaultModel(value: LocalDefaultModel | null) {
    if (disposed)
      return false
    const revision = ++defaultModelPersistenceRevision
    defaultModelSelection.value = value
    const operation = async () => {
      if (disposed)
        return false
      try {
        const stored = await options.api.setDefaultModel(value)
        if (!disposed && revision === defaultModelPersistenceRevision)
          defaultModelSelection.value = stored
        return true
      }
      catch (error) {
        if (!disposed)
          modelProviderError.value = resolveLocalChatErrorMessage(error, options.language.value)
        return false
      }
    }
    persistDefaultModelQueue = persistDefaultModelQueue.then(operation, operation)
    return persistDefaultModelQueue
  }

  return {
    builtinPresets: readonly(builtinPresets),
    acknowledgeModelSourceUpdate,
    addProvider,
    modelProviderError: readonly(modelProviderError),
    authChallenge: readonly(authChallenge),
    cancelAuth,
    clearModelProviderError,
    clearProviderCredential,
    defaultEffort: readonly(defaultEffort),
    defaultModelId: readonly(defaultModelId),
    rememberModelSelection: persistDefaultModel,
    dispose() {
      if (disposed)
        return
      disposed = true
      defaultModelPersistenceRevision += 1
      stopAuthChallenge()
    },
    isAuthenticating: readonly(isAuthenticating),
    isLoadingModelCatalog: readonly(isLoadingModelCatalog),
    isRefreshingModelSnapshot: readonly(isRefreshingModelSnapshot),
    language: options.language,
    loadModelCatalog,
    loginProvider,
    logoutProvider,
    models: readonly(models),
    modelSnapshot: readonly(modelSnapshot),
    mutatingProviderId: readonly(mutatingProviderId),
    openModelSnapshotDirectory,
    providers: readonly(providers),
    registeredModels: readonly(registeredModels),
    removeModel,
    removeProvider,
    renameProvider,
    refreshModelSnapshot,
    respondToAuth,
    restoreModelSourceParameters,
    setDefaultEffort,
    setDefaultModel,
    setModelParameters,
    setModelCatalogSource,
    setModelCapabilities,
    setProviderEnabled,
    setProviderModelEnabled,
    syncingProviderId: readonly(syncingProviderId),
    syncProviderModels,
    upsertCustomProvider,
    createCustomProvider,
    upsertManualModel,
  }
}

export function filterAvailableModels(
  providers: ReadonlyArray<LocalProvider>,
  models: ReadonlyArray<LocalRuntimeModelOption>,
): ReadonlyArray<LocalRuntimeModelOption> {
  const availableProviderIds = new Set(providers
    .filter(provider => provider.added && provider.enabled && provider.status === 'available')
    .map(provider => provider.id))
  return models.filter(model => (
    availableProviderIds.has(model.providerId)
    && model.enabled
    && model.available
  ))
}
