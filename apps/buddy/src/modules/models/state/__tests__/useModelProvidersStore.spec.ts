import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { filterAvailableModels, useModelProvidersStore } from '../useModelProvidersStore'

describe('filterAvailableModels', () => {
  it('exposes models only for enabled and authenticated providers', () => {
    const providers = [
      provider('ready', true, 'available'),
      provider('login', true, 'authentication_required'),
      provider('disabled', false, 'available'),
    ]
    const models = [
      model('ready'),
      model('login'),
      model('disabled'),
      { ...model('ready'), enabled: false, modelId: 'model-disabled' },
      { ...model('ready'), available: false, modelId: 'model-missing' },
    ]

    expect(filterAvailableModels(providers, models).map(item => item.providerId)).toEqual(['ready'])
  })
})

describe('useModelProvidersStore', () => {
  it('reconciles a domain notification that arrives during an in-flight catalog read', async () => {
    const initial = deferred<LocalProvider[]>()
    let changed: () => void = () => {}
    const api = {
      list: vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue([provider('ready', false, 'available')]),
      listBuiltinPresets: async () => [],
      listModels: async () => [model('ready')],
      getDefaultModel: async () => null,
      onAuthChallenge: () => () => {},
      onChanged: (listener: () => void) => {
        changed = listener
        return () => {
          changed = () => {}
        }
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    const reading = store.loadModelCatalog()
    changed()
    changed()
    initial.resolve([provider('ready', true, 'available')])
    await reading
    await vi.waitFor(() => expect(store.providers.value[0]?.enabled).toBe(false))
    expect(store.models.value).toEqual([])
    expect(vi.mocked(api.list).mock.calls).toHaveLength(2)
    store.dispose()
    changed()
    await Promise.resolve()
    expect(vi.mocked(api.list).mock.calls).toHaveLength(2)
  })

  it.each([false, true])('refreshes a mutation that completes during a stale initial load, notification: %s', async (emitNotification) => {
    const initial = deferred<LocalProvider[]>()
    const changed = provider('ready', false, 'available')
    let notifyChanged: () => void = () => {}
    const api = {
      list: vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue([changed]),
      listBuiltinPresets: async () => [],
      listModels: vi.fn(async () => [model('ready')]),
      getDefaultModel: async () => null,
      setDefaultModel: async () => {},
      setEnabled: async () => {
        if (emitNotification)
          notifyChanged()
      },
      onAuthChallenge: () => () => {},
      onChanged: (listener: () => void) => {
        notifyChanged = listener
        return () => {}
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    const loading = store.loadModelCatalog()
    expect(store.loadModelCatalog(true)).toBe(loading)
    const changing = store.setProviderEnabled('ready', false)
    initial.resolve([provider('ready', true, 'available')])
    await expect(loading).resolves.toBe(true)
    await expect(changing).resolves.toBe(true)
    expect(store.providers.value).toEqual([changed])
    expect(store.models.value).toEqual([])
    expect(store.isLoadingModelCatalog.value).toBe(false)
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(store.mutatingProviderId.value).toBeNull()

    vi.mocked(api.list).mockRejectedValueOnce(new Error('RUNTIME_OFFLINE'))
    await expect(store.loadModelCatalog(true)).resolves.toBe(false)
    expect(store.providers.value).toEqual([changed])
    await expect(store.loadModelCatalog(true)).resolves.toBe(true)
    expect(store.modelProviderError.value).toBeNull()
    store.dispose()
  })

  it.each([false, true])('refreshes a batch once when its RPC emits a notification: %s', async (emitNotification) => {
    const rpc = deferred<void>()
    let changed: () => void = () => {}
    let storedModels = [
      { ...model('ready'), enabled: false },
      { ...model('ready'), enabled: false, modelId: 'model-2' },
    ]
    const defaultModel = { providerId: 'ready', modelId: 'model-1', reasoning: null }
    const api = {
      getDefaultModel: async () => defaultModel,
      list: vi.fn(async () => [provider('ready', true, 'available')]),
      listBuiltinPresets: async () => [],
      listModels: vi.fn(async () => storedModels),
      onAuthChallenge: () => () => {},
      onChanged: (listener: () => void) => {
        changed = listener
        return () => {}
      },
      setModelsEnabled: async () => {
        storedModels = storedModels.map(item => ({ ...item, enabled: true }))
        if (emitNotification)
          changed()
        await rpc.promise
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await store.loadModelCatalog()
    expect(store.models.value).toEqual([])
    vi.mocked(api.list).mockClear()
    vi.mocked(api.listModels).mockClear()

    const changing = store.setProviderModelsEnabled('ready', ['model-1', 'model-2'], true)
    expect(store.mutatingProviderId.value).toBe('ready')
    if (emitNotification) {
      // The notification's entire read can finish before the RPC returns.
      await vi.waitFor(() => expect(store.models.value.map(item => item.modelId)).toEqual(['model-1', 'model-2']))
      expect(store.mutatingProviderId.value).toBe('ready')
    }
    else {
      expect(api.list).not.toHaveBeenCalled()
    }
    rpc.resolve()
    await expect(changing).resolves.toBe(true)
    expect(store.models.value.map(item => item.modelId)).toEqual(['model-1', 'model-2'])
    expect(store.registeredModels.value.every(item => item.enabled)).toBe(true)
    expect(store.defaultModelId.value).toBe('ready:model-1')
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(store.mutatingProviderId.value).toBeNull()
    store.dispose()
  })

  it('keeps a mutation locked through a later notification and its follow-up read', async () => {
    const firstRead = deferred<LocalRuntimeModelOption[]>()
    const followupRead = deferred<LocalRuntimeModelOption[]>()
    let changed: () => void = () => {}
    const initialModels = [
      { ...model('ready'), enabled: false },
      { ...model('ready'), enabled: false, modelId: 'model-2' },
    ]
    const api = {
      getDefaultModel: async () => ({ providerId: 'ready', modelId: 'model-1', reasoning: null }),
      list: vi.fn(async () => [provider('ready', true, 'available')]),
      listBuiltinPresets: async () => [],
      listModels: vi.fn().mockResolvedValueOnce(initialModels).mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(followupRead.promise),
      onAuthChallenge: () => () => {},
      onChanged: (listener: () => void) => {
        changed = listener
        return () => {}
      },
      setModelsEnabled: async () => {
        changed()
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await store.loadModelCatalog()
    vi.mocked(api.list).mockClear()
    vi.mocked(api.listModels).mockClear()

    let settled = false
    const changing = store.setProviderModelsEnabled('ready', ['model-1'], true).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(1))
    expect(store.mutatingProviderId.value).toBe('ready')
    expect(settled).toBe(false)
    changed()
    firstRead.resolve([{ ...initialModels[0]!, enabled: true }, initialModels[1]!])
    await vi.waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
    expect(store.models.value.map(item => item.modelId)).toEqual(['model-1'])
    expect(store.mutatingProviderId.value).toBe('ready')
    expect(settled).toBe(false)

    followupRead.resolve(initialModels.map(item => ({ ...item, enabled: true })))
    await expect(changing).resolves.toBe(true)
    expect(store.models.value.map(item => item.modelId)).toEqual(['model-1', 'model-2'])
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(store.mutatingProviderId.value).toBeNull()
    store.dispose()
  })

  it.each(['list', 'listModels'] as const)('returns false and retains the catalog when %s fails after a committed mutation', async (failedRead) => {
    let changed: () => void = () => {}
    let storedModels = [model('ready')]
    const api = {
      getDefaultModel: async () => ({ providerId: 'ready', modelId: 'model-1', reasoning: null }),
      list: vi.fn(async () => [provider('ready', true, 'available')]),
      listBuiltinPresets: async () => [],
      listModels: vi.fn(async () => storedModels),
      onAuthChallenge: () => () => {},
      onChanged: (listener: () => void) => {
        changed = listener
        return () => {}
      },
      setModelsEnabled: async () => {
        storedModels = storedModels.map(item => ({ ...item, enabled: false }))
        changed()
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await store.loadModelCatalog()
    const previousProviders = store.providers.value
    const previousModels = store.registeredModels.value
    vi.mocked(api.list).mockClear()
    vi.mocked(api.listModels).mockClear()
    vi.mocked(api[failedRead]).mockRejectedValueOnce(new Error('RUNTIME_OFFLINE'))

    await expect(store.setProviderModelsEnabled('ready', ['model-1'], false)).resolves.toBe(false)
    expect(storedModels[0]?.enabled).toBe(false)
    expect(store.providers.value).toEqual(previousProviders)
    expect(store.registeredModels.value).toEqual(previousModels)
    expect(store.models.value.map(item => item.modelId)).toEqual(['model-1'])
    expect(store.defaultModelId.value).toBe('ready:model-1')
    expect(store.modelProviderError.value).not.toBeNull()
    expect(store.mutatingProviderId.value).toBeNull()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledTimes(1)

    await expect(store.loadModelCatalog(true)).resolves.toBe(true)
    expect(store.models.value).toEqual([])
    expect(store.modelProviderError.value).toBeNull()
    store.dispose()
  })

  it('does not publish an added provider when its post-commit catalog read fails', async () => {
    let storedProviders = [provider('ready', true, 'available')]
    const api = {
      getDefaultModel: async () => ({ providerId: 'ready', modelId: 'model-1', reasoning: null }),
      list: vi.fn(async () => storedProviders),
      listBuiltinPresets: async () => [],
      listModels: async () => [model('ready')],
      onAuthChallenge: () => () => {},
      onChanged: () => () => {},
      add: async () => {
        const added = provider('new', true, 'available')
        storedProviders = [...storedProviders, added]
        return added
      },
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const store = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await store.loadModelCatalog()
    const previousProviders = store.providers.value
    vi.mocked(api.list).mockRejectedValueOnce(new Error('RUNTIME_OFFLINE'))

    await expect(store.addProvider('new')).resolves.toBeNull()
    expect(storedProviders.map(item => item.id)).toEqual(['ready', 'new'])
    expect(store.providers.value).toEqual(previousProviders)
    expect(store.models.value.map(item => item.modelId)).toEqual(['model-1'])
    expect(store.modelProviderError.value).not.toBeNull()
    expect(store.mutatingProviderId.value).toBeNull()

    await expect(store.loadModelCatalog(true)).resolves.toBe(true)
    expect(store.providers.value.map(item => item.id)).toEqual(['ready', 'new'])
    expect(store.modelProviderError.value).toBeNull()
    store.dispose()
  })

  it('does not expose a provider login cancellation as a provider error', async () => {
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        providers: {
          login: () => Promise.reject(
            new Error('LEXORA_LOCAL_CHAT_ERROR:PROVIDER_LOGIN_CANCELLED:0'),
          ),
          onAuthChallenge: () => () => {},
          onChanged: () => () => {},
        },
        runtime: {
          onStateChanged: () => () => {},
        },
      },
    } as unknown as LexoraDesktopApi
    const store = useModelProvidersStore({ api: api.localChat.providers, language: shallowRef('zh-CN') })

    expect(await store.loginProvider('openai-codex', 'oauth')).toBe(false)
    expect(store.modelProviderError.value).toBeNull()

    store.dispose()
  })

  it('serializes provider login through one model provider store', async () => {
    let loginCalls = 0
    let resolveFirstLogin: (() => void) | undefined
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        notifications: emptyNotificationApi(),
        providers: {
          list: async () => [],
          listBuiltinPresets: async () => [],
          listModels: async () => [],
          getDefaultModel: async () => null,
          login: () => {
            loginCalls += 1
            if (loginCalls > 1)
              return Promise.resolve()
            return new Promise<void>(resolve => resolveFirstLogin = resolve)
          },
          onAuthChallenge: () => () => {},
          onChanged: () => () => {},
        },
        runtime: {
          onStateChanged: () => () => {},
        },
      },
    } as unknown as LexoraDesktopApi
    const store = useModelProvidersStore({ api: api.localChat.providers, language: shallowRef('zh-CN') })

    const firstLogin = store.loginProvider('anthropic', 'api_key')
    expect(store.isAuthenticating.value).toBe(true)
    await expect(store.loginProvider('openai-codex', 'oauth')).resolves.toBe(false)
    expect(loginCalls).toBe(1)

    resolveFirstLogin?.()
    await expect(firstLogin).resolves.toBe(true)
    expect(store.isAuthenticating.value).toBe(false)
    store.dispose()
  })
})

function provider(
  id: string,
  enabled: boolean,
  status: LocalProvider['status'],
): LocalProvider {
  return {
    activeRunCount: 0,
    requestHeaders: [],
    added: true,
    api: null,
    authTypes: ['api_key'],
    baseUrl: null,
    builtinProviderId: id,
    canSyncModels: true,
    custom: false,
    description: null,
    displayName: id,
    enabled,
    enabledModelCount: enabled && status === 'available' ? 1 : 0,
    id,
    modelCount: 1,
    setupComplete: enabled && status === 'available',
    status,
    storedCredentialType: null,
    syncUnavailableReason: null,
  }
}

function model(providerId: string): LocalRuntimeModelOption {
  return {
    available: true,
    type: 'chat',
    sourceType: 'chat',
    typeOverride: null,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilityOverrides: null,
    fileInputMimeTypes: [],
    sourceCapabilities: { image: false, reasoningOptions: ['off'] },
    api: 'openai-completions',
    capabilities: ['text'],
    contextWindow: 4096,
    displayName: providerId,
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: '2026-08-19T00:00:00.000Z',
    maxTokens: 1024,
    modelId: 'model-1',
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId,
    reasoningOptions: [],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 4096,
    sourceMaxTokens: 1024,
    sourceParametersUpdated: false,
  }
}

function emptyNotificationApi() {
  return {
    onChanged: () => () => {},
    list: async () => ({ items: [], unseenCount: 0 }),
  }
}

function emptyAutomationApi() {
  return {
    onChanged: () => () => {},
  }
}

function emptyChatApi() {
  return {
    onRunEvent: () => () => {},
  }
}
