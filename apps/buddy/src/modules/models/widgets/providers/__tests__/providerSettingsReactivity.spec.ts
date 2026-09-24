// @vitest-environment jsdom
import type { LocalBuiltinProviderPreset, LocalCustomProviderModel, LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ModelProvidersStore } from '@/modules/models/state/typing'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, effectScope, h, nextTick, shallowReactive, shallowRef } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { useProviderSetupWizard } from '@/modules/models/state/useProviderSetupWizard'
import DesktopModelsSettings from '../DesktopModelsSettings.vue'
import DesktopProviderAddDialog from '../DesktopProviderAddDialog.vue'
import DesktopProviderDetail from '../DesktopProviderDetail.vue'
import { useProviderDetail } from '../useProviderDetail'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('provider settings prop reactivity', () => {
  it.each(['settings', 'detail', 'wizard'] as const)('%s follows catalog refill, replacement props and locale changes', async (surface) => {
    const first = createStore('Alpha')
    first.providers.value = []
    first.builtinPresets.value = []
    first.registeredModels.value = []
    const current = shallowRef<ModelProvidersStore>(first)
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup() {
        return () => surface === 'settings'
          ? h(DesktopModelsSettings, { providerSettings: current.value })
          : surface === 'detail'
            ? h(DesktopProviderDetail, { providerId: 'service', providerSettings: current.value })
            : h(DesktopProviderAddDialog, { show: true, resumeProviderId: null, providerSettings: current.value })
      },
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()
    expect(document.body.textContent).not.toContain('Alpha')
    first.providers.value = [provider('Alpha')]
    first.builtinPresets.value = [provider('Alpha')]
    first.registeredModels.value = [model('Alpha')]
    await nextTick()
    expect(document.body.textContent).toContain('Alpha')

    const second = createStore('Beta', 'en-US')
    current.value = second
    await nextTick()
    expect(document.body.textContent).toContain('Beta')
    expect(document.body.textContent).not.toContain('Alpha')
    const heading = surface === 'detail' ? 'desktop.providers.models' : 'desktop.providers.addService'
    expect(document.body.textContent).toContain(translateBuddy('en-US', heading))
    first.providers.value = [provider('Stale store')]
    first.registeredModels.value = [model('Stale store')]
    second.providers.value = [provider('Gamma')]
    second.builtinPresets.value = [provider('Gamma')]
    second.registeredModels.value = [model('Gamma')]
    second.language.value = 'zh-CN'
    await nextTick()
    expect(document.body.textContent).toContain('Gamma')
    expect(document.body.textContent).not.toContain('Stale store')
    expect(document.body.textContent).toContain(translateBuddy('zh-CN', heading))
  })

  it('saves model parameters and provider connections through the replacement store', async () => {
    const first = createStore('Alpha')
    const second = createStore('Beta')
    const props = shallowReactive({ providerSettings: first })
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const detail = scope.run(() => useProviderDetail(() => props.providerSettings, () => 'service'))!
    detail.openModelDetail('model')
    props.providerSettings = second
    detail.openModelDetail('model')
    await detail.modelActions.value!.saveParameters({ contextWindow: 8192, maxTokens: 2048 })
    expect(first.registeredModels.value[0]?.maxTokens).toBe(1024)
    expect(second.registeredModels.value[0]?.maxTokens).toBe(2048)
    await detail.connectionActions.save({ api: 'openai-completions', baseUrl: 'https://example.com/v1', displayName: 'Updated', enabled: true, id: 'service', models: [] })
    expect(first.providers.value[0]?.displayName).toBe('Alpha')
    expect(second.providers.value[0]?.displayName).toBe('Updated')
  })

  it('ignores old manual saves after store replacement while allowing the new form to finish', async () => {
    const firstSave = deferred<boolean>()
    const secondSave = deferred<boolean>()
    const first = createStore('Alpha')
    const second = createStore('Beta')
    first.upsertManualModel = () => firstSave.promise
    second.upsertManualModel = () => secondSave.promise
    const props = shallowReactive({ providerSettings: first })
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const detail = scope.run(() => useProviderDetail(() => props.providerSettings, () => 'service'))!
    detail.openManualModelDialog()
    const oldRequest = detail.saveManualModel(manualModel())
    props.providerSettings = second
    detail.openManualModelDialog()
    const newRequest = detail.saveManualModel(manualModel())
    firstSave.resolve(true)
    await oldRequest
    expect(detail.showManualModelDialog.value).toBe(true)
    expect(detail.savingManualModel.value).toBe(true)
    secondSave.resolve(true)
    await newRequest
    expect(detail.showManualModelDialog.value).toBe(false)
    expect(detail.savingManualModel.value).toBe(false)
  })

  it('surfaces an unavailable model through its info icon and clears it from the row', async () => {
    const store = createStore('Alpha')
    store.registeredModels.value = [{
      ...model('Retired'),
      available: false,
      enabled: false,
      modelId: 'retired-model',
    }]
    const cleared: Array<[string, string]> = []
    store.removeModel = async (providerId, modelId) => {
      cleared.push([providerId, modelId])
      store.registeredModels.value = []
      return true
    }
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(DesktopProviderDetail, { providerId: 'service', providerSettings: store }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    const row = root.querySelector('.desktop-provider-detail__model-row')
    expect(row?.querySelector('.desktop-provider-detail__warning')).toBeNull()
    expect(row?.querySelector('.n-switch')).toBeNull()
    expect(row?.textContent).not.toContain(translateBuddy('zh-CN', 'desktop.providers.manage'))
    const availabilityIcon = row?.querySelector('.desktop-provider-detail__model-availability')
    expect(availabilityIcon).not.toBeNull()
    availabilityIcon?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(document.body.textContent).toContain(translateBuddy('zh-CN', 'desktop.providers.modelUnavailableHint'))

    const clearButton = row?.querySelector<HTMLButtonElement>('[aria-label="清理不可用模型"]')
    expect(clearButton).not.toBeNull()
    clearButton?.click()
    await nextTick()
    expect(cleared).toEqual([['service', 'retired-model']])
    expect(root.querySelector('.desktop-provider-detail__model-row')).toBeNull()
  })

  it('keeps manage and enable controls on available models', async () => {
    const store = createStore('Alpha')
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(DesktopProviderDetail, { providerId: 'service', providerSettings: store }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    const row = root.querySelector('.desktop-provider-detail__model-row')
    expect(row?.querySelector('.n-switch')).not.toBeNull()
    expect(row?.textContent).toContain(translateBuddy('zh-CN', 'desktop.providers.manage'))
    expect(row?.querySelector('.desktop-provider-detail__model-availability')).toBeNull()
  })

  it('keeps manage button and switch while showing warning icon when provider has no enabled models', async () => {
    const store = createStore('Alpha')
    store.providers.value = [{
      ...provider('Alpha'),
      enabled: false,
      enabledModelCount: 0,
      modelCount: 0,
      setupComplete: true,
      storedCredentialType: 'api_key',
    }]
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(DesktopModelsSettings, { providerSettings: store }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    const row = root.querySelector('.desktop-models-settings__provider-row')
    expect(row?.textContent).toContain(translateBuddy('zh-CN', 'desktop.providers.manage'))
    expect(row?.textContent).not.toContain(translateBuddy('zh-CN', 'desktop.providers.continueSetup'))
    expect(row?.textContent).not.toContain(translateBuddy('zh-CN', 'common.delete'))

    const availabilityIcon = row?.querySelector('.desktop-models-settings__provider-availability')
    expect(availabilityIcon).not.toBeNull()
    expect(availabilityIcon?.getAttribute('aria-label')).toBe(
      translateBuddy('zh-CN', 'desktop.providers.noEnabledAvailableModelsHint'),
    )

    const switchEl = row?.querySelector('.n-switch')
    expect(switchEl).not.toBeNull()
    expect(switchEl?.classList.contains('n-switch--disabled')).toBe(true)
  })

  it('displays continue setup and delete buttons for incomplete providers', async () => {
    const store = createStore('Beta')
    store.providers.value = [{
      ...provider('Beta'),
      enabled: false,
      enabledModelCount: 0,
      modelCount: 0,
      setupComplete: false,
      storedCredentialType: null,
    }]
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(DesktopModelsSettings, { providerSettings: store }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    const row = root.querySelector('.desktop-models-settings__provider-row')
    expect(row?.textContent).toContain(translateBuddy('zh-CN', 'desktop.providers.continueSetup'))
    expect(row?.textContent).toContain(translateBuddy('zh-CN', 'common.delete'))
    expect(row?.textContent).not.toContain(translateBuddy('zh-CN', 'desktop.providers.manage'))
    expect(row?.querySelector('.desktop-models-settings__provider-availability')).toBeNull()
  })
})

describe('provider wizard ownership', () => {
  it('creates another instance of an already added preset and resumes only its own setup', async () => {
    const store = createStore('DeepSeek')
    const show = shallowRef(true)
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const wizard = scope.run(() => useProviderSetupWizard({ providerSettings: () => store, show, resumeProviderId: shallowRef(null) }))!
    const preset = wizard.filteredProviders.value[0]!
    await wizard.addBuiltin(preset)
    const firstId = wizard.selectedProviderId.value
    expect(firstId).not.toBe('service')
    expect(store.providers.value).toHaveLength(2)
    expect(wizard.step.value).toBe(2)
    wizard.goToPreviousStep()
    await wizard.addBuiltin(preset)
    expect(wizard.selectedProviderId.value).toBe(firstId)
    expect(store.providers.value).toHaveLength(2)
    show.value = false
    show.value = true
    await wizard.addBuiltin(preset)
    expect(store.providers.value).toHaveLength(3)
    expect(wizard.selectedProviderId.value).not.toBe(firstId)
    wizard.builtinDisplayName.value = 'DeepSeek Work'
    await wizard.login('api_key')
    expect(wizard.selectedProvider.value?.displayName).toBe('DeepSeek Work')
    expect(store.providers.value[0]?.displayName).toBe('DeepSeek')
  })

  it('keeps example endpoints out of saved form values and validates custom connections', async () => {
    const store = createStore('Alpha')
    const show = shallowRef(true)
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const wizard = scope.run(() => useProviderSetupWizard({ providerSettings: () => store, show, resumeProviderId: shallowRef(null) }))!
    wizard.updateCustomName('Proxy')
    expect(wizard.customForm.baseUrl).toBe('')
    expect(wizard.canContinueCustom.value).toBe(false)
    for (const url of ['   ', 'not-a-url', 'ftp://models.example.test/v1', 'http://user:secret@models.example.test/v1']) {
      wizard.customForm.baseUrl = url
      expect(wizard.canContinueCustom.value).toBe(false)
    }
    for (const url of ['https://models.example.test/v1', 'http://models.example.test/v1', 'http://127.0.0.1:8000/v1']) {
      wizard.customForm.baseUrl = url
      expect(wizard.canContinueCustom.value).toBe(true)
    }
    show.value = false
    show.value = true
    expect(wizard.customForm.baseUrl).toBe('')
  })

  it('resumes after asynchronous catalog refill without overwriting later connection edits', () => {
    const store = createStore('Alpha')
    store.providers.value = []
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const wizard = scope.run(() => useProviderSetupWizard({ providerSettings: () => store, show: shallowRef(true), resumeProviderId: shallowRef('service') }))!
    expect(wizard.step.value).toBe(1)
    store.providers.value = [{ ...provider('Alpha'), custom: true, storedCredentialType: null }]
    expect(wizard.step.value).toBe(2)
    expect(wizard.customForm.displayName).toBe('Alpha')
    wizard.customForm.displayName = 'Unsaved name'
    store.providers.value = [{ ...store.providers.value[0]!, modelCount: 2 }]
    expect(wizard.customForm.displayName).toBe('Unsaved name')
  })

  it('targets new store actions and ignores old login and completion responses', async () => {
    const first = createStore('Alpha')
    const second = createStore('Beta')
    first.providers.value = [{ ...provider('Alpha'), storedCredentialType: null }]
    second.providers.value = [{ ...provider('Beta'), storedCredentialType: null }]
    const login = deferred<boolean>()
    first.loginProvider = () => login.promise
    const props = shallowReactive({ providerSettings: first })
    const show = shallowRef(true)
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const wizard = scope.run(() => useProviderSetupWizard({ providerSettings: () => props.providerSettings, show, resumeProviderId: shallowRef('service') }))!
    const oldLogin = wizard.login('api_key')
    props.providerSettings = second
    login.resolve(true)
    await oldLogin
    expect(wizard.step.value).toBe(2)
    await wizard.toggleModel('model', false)
    expect(first.registeredModels.value[0]?.enabled).toBe(true)
    expect(second.registeredModels.value[0]?.enabled).toBe(false)
    await wizard.toggleModel('model', true)
    second.providers.value = [provider('Beta')]
    const enable = deferred<boolean>()
    second.setProviderEnabled = () => enable.promise
    const oldFinish = wizard.finish()
    show.value = false
    show.value = true
    enable.resolve(true)
    await oldFinish
    expect(show.value).toBe(true)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function manualModel(): LocalCustomProviderModel {
  return { id: 'manual', name: 'Manual', contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'] }
}

function provider(displayName: string): LocalProvider {
  return {
    activeRunCount: 0,
    requestHeaders: [],
    added: true,
    api: null,
    authTypes: ['api_key'],
    baseUrl: null,
    builtinProviderId: 'service',
    canSyncModels: true,
    custom: false,
    description: null,
    displayName,
    enabled: true,
    enabledModelCount: 1,
    id: 'service',
    modelCount: 1,
    setupComplete: true,
    status: 'available',
    storedCredentialType: 'api_key',
    syncUnavailableReason: null,
  }
}

function model(displayName: string): LocalRuntimeModelOption {
  return {
    available: true,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilityOverrides: null,
    fileInputMimeTypes: [],
    sourceCapabilities: { image: false, reasoningOptions: ['off'] },
    api: 'openai-completions',
    capabilities: ['text'],
    contextWindow: 4096,
    displayName,
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: null,
    maxTokens: 1024,
    modelId: 'model',
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId: 'service',
    reasoningOptions: [],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 4096,
    sourceMaxTokens: 1024,
    sourceParametersUpdated: false,
  }
}

function createStore(name: string, locale: BuddyLocale = 'zh-CN') {
  const providers = shallowRef<ReadonlyArray<LocalProvider>>([provider(name)])
  const registeredModels = shallowRef<ReadonlyArray<LocalRuntimeModelOption>>([model(name)])
  const succeed = async () => true
  return {
    builtinPresets: shallowRef<ReadonlyArray<LocalBuiltinProviderPreset>>([provider(name)]),
    authChallenge: shallowRef(null),
    defaultEffort: shallowRef(null),
    defaultModelId: shallowRef(null),
    isAuthenticating: shallowRef(false),
    isLoadingModelCatalog: shallowRef(false),
    isRefreshingModelSnapshot: shallowRef(false),
    language: shallowRef(locale),
    modelProviderError: shallowRef(null),
    models: registeredModels,
    modelSnapshot: shallowRef(null),
    mutatingProviderId: shallowRef(null),
    providers,
    registeredModels,
    syncingProviderId: shallowRef(null),
    acknowledgeModelSourceUpdate: succeed,
    addProvider: async (builtinProviderId: string) => {
      const instance = { ...provider(name), builtinProviderId, id: `instance-${providers.value.length}`, storedCredentialType: null }
      providers.value = [...providers.value, instance]
      return instance
    },
    renameProvider: async (id: string, displayName: string) => {
      providers.value = providers.value.map(item => item.id === id ? { ...item, displayName } : item)
      return true
    },
    cancelAuth: async () => {},
    clearModelProviderError: () => {},
    clearProviderCredential: succeed,
    createCustomProvider: async () => null,
    dispose: () => {},
    loadModelCatalog: succeed,
    loginProvider: succeed,
    logoutProvider: succeed,
    openModelSnapshotDirectory: succeed,
    rememberModelSelection: succeed,
    removeModel: async (providerId, modelId) => {
      registeredModels.value = registeredModels.value.filter(item => !(item.providerId === providerId && item.modelId === modelId))
      return true
    },
    removeProvider: succeed,
    refreshModelSnapshot: succeed,
    respondToAuth: succeed,
    restoreModelSourceParameters: succeed,
    setModelCatalogSource: succeed,
    setModelCapabilities: succeed,
    setDefaultEffort: succeed,
    setDefaultModel: succeed,
    setProviderEnabled: succeed,
    syncProviderModels: succeed,
    upsertManualModel: succeed,
    setModelParameters: async (providerId, modelId, parameters) => {
      registeredModels.value = registeredModels.value.map(item => item.providerId === providerId && item.modelId === modelId ? { ...item, ...parameters } : item)
      return true
    },
    setProviderModelEnabled: async (providerId, modelId, enabled) => {
      registeredModels.value = registeredModels.value.map(item => item.providerId === providerId && item.modelId === modelId ? { ...item, enabled } : item)
      return true
    },
    upsertCustomProvider: async (input) => {
      providers.value = providers.value.map(item => item.id === input.id ? { ...item, displayName: input.displayName } : item)
      return true
    },
  } satisfies ModelProvidersStore
}
