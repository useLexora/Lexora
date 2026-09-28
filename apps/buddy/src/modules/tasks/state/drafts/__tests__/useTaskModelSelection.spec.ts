import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import { buddyComposerDraftSchema } from '@buddy-shared/conversation/composerDraft'
import { describe, expect, it, vi } from 'vitest'
import { computed, shallowRef } from 'vue'
import { useModelProvidersStore } from '@/modules/models'
import { useChatDrafts } from '../useChatDrafts'
import { useTaskModelSelection } from '../useTaskModelSelection'

describe('useTaskModelSelection', () => {
  it('keeps a selected model draft sendable after the Runtime schema confirms its save', async () => {
    const api = {
      getDefaultModel: async () => ({ providerId: 'anthropic', modelId: 'model-1', reasoning: null }),
      list: async () => [provider('anthropic', true, 'available')],
      listBuiltinPresets: async () => [],
      listModels: async () => [model('anthropic'), { ...model('anthropic'), modelId: 'model-2' }],
      onChanged: () => () => {},
      onAuthChallenge: () => () => {},
      setDefaultModel: async (value: unknown) => value,
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const catalog = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await catalog.loadModelCatalog()
    const selection = useTaskModelSelection(catalog)
    const drafts = useChatDrafts({ onChange: vi.fn(), targetKey: computed(() => 'global') })
    await selection.selectModel('anthropic:model-2')
    drafts.setModelSelection(selection.currentSelection())
    const submitted = drafts.snapshot('global')
    const remote = buddyComposerDraftSchema.parse({
      content: submitted.content,
      draftId: submitted.draftId,
      executionConfig: {
        approvalPolicy: submitted.approvalPolicy,
        executionProfile: submitted.executionProfile,
      },
      modelSelection: submitted.modelSelection,
      revision: 1,
      scope: { kind: 'global' },
      updatedAt: '2026-09-08T00:00:00.000Z',
    })

    drafts.confirmSave(submitted, remote)
    expect(drafts.isPersisted(drafts.snapshot('global'))).toBe(true)

    await selection.selectModel('anthropic:model-1')
    drafts.setModelSelection(selection.currentSelection())
    drafts.confirmSave(submitted, remote)
    expect(drafts.isPersisted(drafts.snapshot('global'))).toBe(false)
    expect(drafts.modelSelection.value?.modelId).toBe('model-1')
    selection.dispose()
    catalog.dispose()
  })

  it('keeps task selections independent when another task changes the application default', async () => {
    const api = {
      getDefaultModel: async () => ({ providerId: 'anthropic', modelId: 'model-1', reasoning: null }),
      list: async () => [provider('anthropic', true, 'available')],
      listBuiltinPresets: async () => [],
      listModels: async () => [model('anthropic'), { ...model('anthropic'), modelId: 'model-2' }],
      onChanged: () => () => {},
      onAuthChallenge: () => () => {},
      setDefaultModel: async (value: unknown) => value,
    } as unknown as LexoraDesktopApi['localChat']['providers']
    const catalog = useModelProvidersStore({ api, language: shallowRef('zh-CN') })
    await catalog.loadModelCatalog()
    const first = useTaskModelSelection(catalog)
    const second = useTaskModelSelection(catalog)

    await first.selectModel('anthropic:model-2')
    expect(first.selectedModelId.value).toBe('anthropic:model-2')
    expect(second.selectedModelId.value).toBe('anthropic:model-1')
    expect(catalog.defaultModelId.value).toBe('anthropic:model-2')

    second.selectDefaultModel()
    expect(second.selectedModelId.value).toBe('anthropic:model-2')
    first.dispose()
    second.dispose()
    catalog.dispose()
  })

  it('persists each chat model and reasoning selection as the next conversation default', async () => {
    const models = [
      {
        ...model('anthropic'),
        capabilities: ['text', 'reasoning'],
        reasoningOptions: ['off', 'low', 'medium', 'high'],
      },
      {
        ...model('anthropic'),
        capabilities: ['text', 'reasoning'],
        displayName: 'Claude B',
        modelId: 'claude-b',
        reasoningOptions: ['off', 'low', 'medium', 'high'],
      },
    ]
    const setDefaultModel = vi.fn(async (value: {
      modelId: string
      providerId: string
      reasoning: string | null
    } | null) => value)
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        notifications: emptyNotificationApi(),
        providers: {
          getDefaultModel: async () => ({
            modelId: 'model-1',
            providerId: 'anthropic',
            reasoning: 'high',
          }),
          list: async () => [provider('anthropic', true, 'available')],
          listBuiltinPresets: async () => [],
          listModels: async () => models,
          onChanged: () => () => {},
          onAuthChallenge: () => () => {},
          setDefaultModel,
        },
        runtime: {
          getStatus: async () => ({
            lastError: null,
            pid: 42,
            restartAttempt: 0,
            status: 'ready',
          }),
          onStateChanged: () => () => {},
        },
      },
      settings: { get: () => Promise.reject(new Error('settings unavailable')) },
    } as unknown as LexoraDesktopApi
    const catalog = useModelProvidersStore({ api: api.localChat.providers, language: shallowRef('zh-CN') })
    const selection = useTaskModelSelection(catalog)

    await catalog.loadModelCatalog()
    expect(catalog.defaultModelId.value).toBe('anthropic:model-1')
    expect(catalog.defaultEffort.value).toBe('high')
    expect(selection.selectedModelId.value).toBe('anthropic:model-1')
    expect(selection.selectedEffort.value).toBe('high')

    await selection.selectModel('anthropic:claude-b')
    expect(selection.selectedModelId.value).toBe('anthropic:claude-b')
    expect(selection.selectedEffort.value).toBe('medium')
    expect(setDefaultModel).toHaveBeenCalledWith({
      modelId: 'claude-b',
      providerId: 'anthropic',
      reasoning: 'medium',
    })
    expect(catalog.defaultModelId.value).toBe('anthropic:claude-b')

    await selection.setSelectedEffort('off')
    expect(setDefaultModel).toHaveBeenLastCalledWith({
      modelId: 'claude-b',
      providerId: 'anthropic',
      reasoning: 'off',
    })
    expect(catalog.defaultEffort.value).toBe('off')

    selection.restoreConversationModelSelection({
      modelId: 'model-1',
      providerId: 'anthropic',
      reasoning: 'high',
      serviceTier: null,
    })
    expect(selection.selectedModelId.value).toBe('anthropic:model-1')
    expect(selection.selectedEffort.value).toBe('high')
    expect(catalog.defaultModelId.value).toBe('anthropic:claude-b')
    expect(catalog.defaultEffort.value).toBe('off')

    selection.selectDefaultModel()
    expect(selection.selectedModelId.value).toBe('anthropic:claude-b')
    expect(selection.selectedEffort.value).toBe('off')
    selection.dispose()
    catalog.dispose()
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
