import type { LocalBuiltinProviderPreset, LocalCustomProvider, LocalCustomProviderModel, LocalProvider } from '@buddy-shared/providers/providerApi'
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { ModelProvidersStore } from '@/modules/models/state/typing'
import { customProviderSchema } from '@buddy-shared/providers/providerApi'

import { providerDisplayNameSchema, supportsUnauthenticatedProviderApi } from '@buddy-shared/providers/providerInput'
import { computed, onScopeDispose, reactive, shallowRef, watch } from 'vue'
import { desktopProviderApiOptions } from '@/modules/models/model/desktopProviderApiOptions'

interface ValueRef<T> {
  readonly value: T
}

interface WritableValueRef<T> {
  value: T
}

interface UseProviderSetupWizardOptions {
  providerSettings: () => ModelProvidersStore
  resumeProviderId: ValueRef<string | null>
  show: WritableValueRef<boolean>
  startAtConnection?: ValueRef<boolean | undefined>
}

export function useProviderSetupWizard(options: UseProviderSetupWizardOptions) {
  const { providerSettings, resumeProviderId, show } = options
  let generation = 0
  const step = shallowRef(1)
  const furthestStep = shallowRef(1)
  const sourceTab = shallowRef<'builtin' | 'custom'>('builtin')
  const providerQuery = shallowRef('')
  const modelQuery = shallowRef('')
  const selectedProviderId = shallowRef<string | null>(null)
  const manualFormKey = shallowRef(0)
  const showManualModelDialog = shallowRef(false)
  const savingManualModel = shallowRef(false)
  const creatingCustom = shallowRef(false)
  const savingAuthentication = shallowRef(false)
  const customIdConflict = shallowRef<string | null>(null)
  const builtinDisplayName = shallowRef('')
  const builtinHeaders = reactive({ requestHeaders: [] as ProviderRequestHeader[] })
  const addingBuiltin = shallowRef(false)
  const customForm = reactive({
    api: desktopProviderApiOptions[0]!.value,
    baseUrl: '',
    description: '',
    displayName: '',
    id: createCustomId(),
    requestHeaders: [] as ProviderRequestHeader[],
  })
  const providers = computed(() => providerSettings().providers.value)
  const reservedCustomIds = computed(() => [
    ...providerSettings().builtinPresets.value.map(provider => provider.id),
    ...providers.value.filter(provider => provider.id !== selectedProviderId.value).map(provider => provider.id),
  ])
  const resumeProviderAvailable = computed(() => providers.value.some(provider => provider.id === resumeProviderId.value))
  const selectedProvider = computed(() => providers.value.find(
    provider => provider.id === selectedProviderId.value,
  ) ?? null)
  const providerModels = computed(() => providerSettings().registeredModels.value.filter(
    model => model.providerId === selectedProviderId.value,
  ))
  const filteredProviderModels = computed(() => {
    const query = modelQuery.value.trim().toLocaleLowerCase()
    if (!query)
      return providerModels.value
    return providerModels.value.filter(model => (
      model.displayName.toLocaleLowerCase().includes(query)
      || model.modelId.toLocaleLowerCase().includes(query)
    ))
  })
  const enabledModels = computed(() => providerModels.value.filter(
    model => model.enabled && model.available,
  ))
  const visibleAvailableModels = computed(() => filteredProviderModels.value.filter(model => model.available))
  const modelSelectionBusy = computed(() => (
    providerSettings().mutatingProviderId.value === selectedProviderId.value
  ))
  const canSelectVisibleModels = computed(() => (
    !modelSelectionBusy.value && visibleAvailableModels.value.some(model => !model.enabled)
  ))
  const canClearVisibleModels = computed(() => (
    !modelSelectionBusy.value && visibleAvailableModels.value.some(model => model.enabled)
  ))
  const filteredProviders = computed(() => {
    const query = providerQuery.value.trim().toLocaleLowerCase()
    return providerSettings().builtinPresets.value.filter(provider => (
      !query
      || provider.displayName.toLocaleLowerCase().includes(query)
      || provider.id.toLocaleLowerCase().includes(query)
    ))
  })
  const stepCount = computed(() => 3)
  const canContinueCustom = computed(() => customProviderSchema.safeParse({
    ...customForm,
    baseUrl: customForm.baseUrl.trim(),
    enabled: false,
    models: [],
  }).success)
  const canLogin = computed(() => selectedProvider.value?.custom || providerDisplayNameSchema.safeParse(builtinDisplayName.value).success)
  const canContinueWithoutAuthentication = computed(() => (
    selectedProvider.value?.custom === true
    && supportsUnauthenticatedProviderApi(selectedProvider.value.api)
  ))
  const connectionBusy = computed(() => (
    savingAuthentication.value
    || providerSettings().isAuthenticating.value
    || (selectedProvider.value !== null && providerSettings().mutatingProviderId.value === selectedProvider.value.id)
  ))
  const hasAuthentication = computed(() => (
    selectedProvider.value?.authentication === 'none' || !!selectedProvider.value?.storedCredentialType
  ))
  const canComplete = computed(() => hasAuthentication.value && enabledModels.value.length > 0)

  watch([show, providerSettings, () => resumeProviderId.value, resumeProviderAvailable, () => options.startAtConnection?.value], ([visible], [wasVisible]) => {
    generation += 1
    savingManualModel.value = false
    creatingCustom.value = false
    savingAuthentication.value = false
    customIdConflict.value = null
    showManualModelDialog.value = false
    if (visible || wasVisible)
      providerSettings().clearModelProviderError()
    if (!visible)
      return
    selectedProviderId.value = resumeProviderId.value
    const provider = selectedProvider.value
    sourceTab.value = provider?.custom ? 'custom' : 'builtin'
    if (!provider) {
      resetNewProviderForm()
      resetSteps(1)
      return
    }
    if (provider.custom) {
      populateCustomForm(provider)
    }
    else {
      builtinDisplayName.value = provider.displayName
      builtinHeaders.requestHeaders = (provider.requestHeaders ?? []).map(header => ({ ...header }))
    }
    resetSteps(hasAuthentication.value ? 3 : 2)
    if (options.startAtConnection?.value)
      step.value = 2
  }, { flush: 'sync', immediate: true })

  watch(show, (visible, wasVisible) => {
    if (visible && !wasVisible)
      modelQuery.value = ''
  })

  watch(selectedProviderId, () => {
    modelQuery.value = ''
  })

  onScopeDispose(() => {
    generation += 1
  })

  function updateCustomName(value: string) {
    customForm.displayName = value
  }

  function updateCustomForm(value: typeof customForm) {
    Object.assign(customForm, value)
    customIdConflict.value = null
    providerSettings().clearModelProviderError()
  }

  function closeDialog() {
    providerSettings().clearModelProviderError()
    show.value = false
  }

  async function addBuiltin(provider: LocalBuiltinProviderPreset) {
    if (addingBuiltin.value)
      return
    if (provider.id === selectedProvider.value?.builtinProviderId && furthestStep.value > 1) {
      navigateToReachedStep(2)
      return
    }
    const requestGeneration = generation
    addingBuiltin.value = true
    try {
      const instance = await providerSettings().addProvider(provider.id)
      if (!instance || requestGeneration !== generation)
        return
      selectedProviderId.value = instance.id
      builtinDisplayName.value = instance.displayName
      builtinHeaders.requestHeaders = []
      advanceToStep(2)
    }
    finally {
      addingBuiltin.value = false
    }
  }

  async function createCustom() {
    if (!canContinueCustom.value || creatingCustom.value)
      return
    const requestGeneration = generation
    const input: LocalCustomProvider = {
      api: customForm.api as LocalCustomProvider['api'],
      authentication: selectedProvider.value?.authentication === 'none' && supportsUnauthenticatedProviderApi(customForm.api) ? 'none' : 'api_key',
      baseUrl: customForm.baseUrl.trim(),
      description: customForm.description.trim() || undefined,
      displayName: customForm.displayName.trim(),
      enabled: selectedProvider.value?.enabled ?? false,
      id: customForm.id.trim(),
      models: [],
      requestHeaders: customForm.requestHeaders.map(header => ({ ...header })),
    }
    if (reservedCustomIds.value.includes(input.id)) {
      customIdConflict.value = input.id
      return
    }
    creatingCustom.value = true
    try {
      const result = selectedProvider.value?.custom
        ? await providerSettings().upsertCustomProvider(input)
        : await providerSettings().createCustomProvider(input)
      if (requestGeneration !== generation)
        return
      if (result === 'conflict') {
        customIdConflict.value = input.id
        return
      }
      if (!result)
        return
      selectedProviderId.value = input.id
      advanceToStep(2)
    }
    finally {
      if (requestGeneration === generation)
        creatingCustom.value = false
    }
  }

  async function login(authType: 'api_key' | 'oauth') {
    const provider = selectedProvider.value
    if (!provider || !canLogin.value || connectionBusy.value || provider.activeRunCount > 0)
      return
    const requestGeneration = generation
    if (!provider.custom) {
      if (!await providerSettings().renameProvider(provider.id, builtinDisplayName.value.trim(), builtinHeaders.requestHeaders.map(header => ({ ...header }))) || requestGeneration !== generation)
        return
    }
    const succeeded = await providerSettings().loginProvider(provider.id, authType)
    if (succeeded && requestGeneration === generation && selectedProviderId.value === provider.id)
      advanceToStep(3)
  }

  async function continueWithoutAuthentication() {
    const provider = selectedProvider.value
    if (!provider || !canContinueWithoutAuthentication.value || connectionBusy.value || provider.activeRunCount > 0)
      return
    const requestGeneration = generation
    providerSettings().clearModelProviderError()
    savingAuthentication.value = true
    try {
      const saved = await providerSettings().upsertCustomProvider({
        id: provider.id,
        api: provider.api as LocalCustomProvider['api'],
        authentication: 'none',
        baseUrl: provider.baseUrl ?? '',
        displayName: provider.displayName,
        description: provider.description ?? undefined,
        enabled: provider.enabled,
        requestHeaders: (provider.requestHeaders ?? []).map(header => ({ ...header })),
      })
      if (saved && requestGeneration === generation && selectedProviderId.value === provider.id)
        advanceToStep(3)
    }
    finally {
      if (requestGeneration === generation)
        savingAuthentication.value = false
    }
  }

  async function saveManualModel(model: LocalCustomProviderModel) {
    const provider = selectedProvider.value
    if (!provider || savingManualModel.value)
      return
    const requestGeneration = generation
    const formKey = manualFormKey.value
    savingManualModel.value = true
    try {
      const saved = await providerSettings().upsertManualModel(provider.id, model)
      if (requestGeneration !== generation || formKey !== manualFormKey.value || selectedProviderId.value !== provider.id)
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

  async function toggleModel(modelId: string, enabled: boolean) {
    const provider = selectedProvider.value
    if (provider)
      await providerSettings().setProviderModelEnabled(provider.id, modelId, enabled)
  }

  async function setVisibleModelsEnabled(enabled: boolean) {
    const provider = selectedProvider.value
    if (!provider || modelSelectionBusy.value)
      return
    const modelIds = visibleAvailableModels.value
      .filter(model => model.enabled !== enabled)
      .map(model => model.modelId)
    if (!modelIds.length)
      return
    await providerSettings().setProviderModelsEnabled(provider.id, modelIds, enabled)
  }

  async function continueFromModels() {
    if (!canComplete.value)
      return
    await finish()
  }

  async function finish() {
    const provider = selectedProvider.value
    if (!provider || !canComplete.value)
      return
    const requestGeneration = generation
    const succeeded = await providerSettings().setProviderEnabled(provider.id, true)
    if (succeeded && requestGeneration === generation && selectedProviderId.value === provider.id)
      closeDialog()
  }

  function goToPreviousStep() {
    navigateToReachedStep(step.value - 1)
  }

  function advanceToStep(nextStep: number) {
    step.value = nextStep
    furthestStep.value = Math.max(furthestStep.value, nextStep)
  }

  function navigateToReachedStep(nextStep: number) {
    if (connectionBusy.value || nextStep < 1 || nextStep > Math.min(furthestStep.value, stepCount.value))
      return
    providerSettings().clearModelProviderError()
    if (nextStep === 1 && selectedProvider.value?.custom)
      populateCustomForm(selectedProvider.value)
    step.value = nextStep
  }

  function resetSteps(initialStep: number) {
    step.value = initialStep
    furthestStep.value = initialStep
  }

  function populateCustomForm(provider: LocalProvider) {
    customForm.api = provider.api as LocalCustomProvider['api']
    customForm.baseUrl = provider.baseUrl ?? ''
    customForm.description = provider.description ?? ''
    customForm.displayName = provider.displayName
    customForm.id = provider.id
    customForm.requestHeaders = (provider.requestHeaders ?? []).map(header => ({ ...header }))
  }

  function resetNewProviderForm() {
    sourceTab.value = 'builtin'
    providerQuery.value = ''
    modelQuery.value = ''
    selectedProviderId.value = null
    customForm.api = desktopProviderApiOptions[0]!.value
    customForm.baseUrl = ''
    builtinDisplayName.value = ''
    customForm.description = ''
    customForm.displayName = ''
    customForm.id = createCustomId()
    customForm.requestHeaders = []
    builtinHeaders.requestHeaders = []
  }

  return {
    addingBuiltin,
    builtinDisplayName,
    builtinHeaders,
    canLogin,
    canContinueWithoutAuthentication,
    connectionBusy,
    continueWithoutAuthentication,
    savingAuthentication,
    addBuiltin,
    canComplete,
    canContinueCustom,
    canClearVisibleModels,
    canSelectVisibleModels,
    closeDialog,
    continueFromModels,
    createCustom,
    customForm,
    creatingCustom,
    customIdConflict,
    reservedCustomIds,
    updateCustomForm,
    enabledModels,
    filteredProviders,
    filteredProviderModels,
    finish,
    furthestStep,
    goToPreviousStep,
    login,
    manualFormKey,
    modelQuery,
    modelSelectionBusy,
    navigateToReachedStep,
    openManualModelDialog,
    providerModels,
    providerQuery,
    saveManualModel,
    savingManualModel,
    selectedProvider,
    selectedProviderId,
    showManualModelDialog,
    sourceTab,
    step,
    stepCount,
    toggleModel,
    setVisibleModelsEnabled,
    updateCustomName,
  }
}

function createCustomId(): string {
  return `custom-${crypto.randomUUID()}`
}
