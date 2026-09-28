import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyComposerDraftModelSelection } from '@buddy-shared/conversation/composerDraft'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { describe, expect, it, vi } from 'vitest'
import { computed, shallowRef } from 'vue'
import { useModelProvidersStore } from '@/modules/models'
import { useChatDrafts } from '../useChatDrafts'
import { useTaskDraftModelBinding } from '../useTaskDraftModelBinding'
import { useTaskModelPersistence } from '../useTaskModelPersistence'
import { useTaskModelSelection } from '../useTaskModelSelection'

describe('draft-owned task model configuration', () => {
  it('displays the saved Draft configuration without changing the next conversation default', async () => {
    const fixture = await createFixture()
    const saved = { ...modelSelection('model-2'), reasoning: 'high' as const, serviceTier: 'priority' as const }
    fixture.confirmOpen(saved)
    await fixture.catalog.loadModelCatalog(true)

    expect(fixture.selection.currentSelection()).toEqual(saved)
    expect(fixture.drafts.modelSelection.value).toEqual(saved)
    expect(fixture.selection.selectedModelId.value).toBe('provider:model-2')
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(true)
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-1')
    expect(fixture.setDefaultModel).not.toHaveBeenCalled()
  })

  it('supplies the next default only to a newly opened Draft and leaves unread remote state untouched', async () => {
    const fixture = await createFixture()
    const initial = fixture.drafts.snapshot('global')
    fixture.binding.restoreScope()
    await fixture.catalog.loadModelCatalog(true)

    expect(fixture.drafts.snapshot('global')).toEqual(initial)
    expect(fixture.binding.initialModelSelection('global')).toEqual(modelSelection('model-1'))
    fixture.confirmOpen(fixture.binding.initialModelSelection('global'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-1'))
    expect(fixture.selection.currentSelection()).toEqual(fixture.drafts.modelSelection.value)
  })

  it('restores each scope model while user choices still update the next conversation default', async () => {
    const fixture = await createFixture()
    fixture.confirmOpen(modelSelection('model-1'))
    fixture.targetKey.value = 'space:space-1'
    fixture.binding.restoreScope()
    await fixture.commands.selectChatModel('provider:model-2')
    fixture.confirmOpen(modelSelection('model-2'))
    fixture.targetKey.value = 'global'
    fixture.binding.restoreScope()

    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-1'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-1'))
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-2')
    fixture.targetKey.value = 'space:space-1'
    fixture.binding.restoreScope()
    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-2'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-2'))
  })

  it('preserves user model, effort and service-tier choices made while a remote open is pending', async () => {
    const fixture = await createFixture()
    fixture.confirmOpen(modelSelection('model-1'))
    const submitted = fixture.drafts.snapshot('global')
    await fixture.commands.selectChatModel('provider:model-2')
    await fixture.commands.setChatEffort('high')
    await fixture.commands.setChatServiceTier('priority')
    fixture.confirmOpen(modelSelection('model-1'), submitted)
    const selected = { ...modelSelection('model-2'), reasoning: 'high', serviceTier: 'priority' }

    expect(fixture.selection.currentSelection()).toEqual(selected)
    expect(fixture.drafts.modelSelection.value).toEqual(selected)
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-2')
    expect(fixture.catalog.defaultEffort.value).toBe('high')
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(false)
  })

  it('does not change the visible model when another scope finishes opening late', async () => {
    const fixture = await createFixture()
    const submitted = fixture.drafts.snapshot('global')
    fixture.targetKey.value = 'space:space-1'
    fixture.binding.restoreScope()
    await fixture.commands.selectChatModel('provider:model-2')
    fixture.confirmOpen(modelSelection('model-1'), submitted)

    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-2'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-2'))
    expect(fixture.drafts.snapshot('global').modelSelection).toEqual(modelSelection('model-1'))
  })

  it('restores the source Draft model when cancelling an isolated message edit', async () => {
    const fixture = await createFixture()
    fixture.confirmOpen(modelSelection('model-1'))
    fixture.drafts.beginIsolated('message-edit:conversation:branch:message', createBuddyUserContent('edited message'))
    await fixture.commands.selectChatModel('provider:model-2')
    expect(fixture.selection.selectedModelId.value).toBe('provider:model-2')

    fixture.drafts.cancelIsolated('message-edit:conversation:branch:message')

    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-1'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-1'))
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-2')
  })

  it('retains saved unavailable model parameters instead of substituting the catalog default', async () => {
    const fixture = await createFixture()
    const saved = { ...modelSelection('removed-model'), reasoning: 'high' as const, serviceTier: 'priority' as const }
    fixture.confirmOpen(saved)
    await fixture.catalog.loadModelCatalog(true)

    expect(fixture.selection.selectedModel.value).toBeNull()
    expect(fixture.selection.selectedModelId.value).toBe('provider:removed-model')
    expect(fixture.selection.currentSelection()).toEqual(saved)
    expect(fixture.drafts.modelSelection.value).toEqual(saved)
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(true)
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-1')
  })
})

async function createFixture() {
  const setDefaultModel = vi.fn(async value => value)
  const catalog = useModelProvidersStore({
    api: {
      getDefaultModel: async () => ({ modelId: 'model-1', providerId: 'provider', reasoning: 'medium' }),
      listBuiltinPresets: async () => [],
      list: async () => [{
        activeRunCount: 0,
        added: true,
        api: null,
        authTypes: ['api_key'],
        baseUrl: null,
        canSyncModels: true,
        custom: false,
        displayName: 'Provider',
        enabled: true,
        enabledModelCount: 2,
        id: 'provider',
        modelCount: 2,
        setupComplete: true,
        status: 'available',
        storedCredentialType: 'api_key',
        syncUnavailableReason: null,
      }],
      listModels: async () => ['model-1', 'model-2'].map(model),
      onChanged: () => () => {},
      onAuthChallenge: () => () => {},
      setDefaultModel,
    } as unknown as LocalChatApi['providers'],
    language: shallowRef('zh-CN'),
  })
  await catalog.loadModelCatalog()
  const selection = useTaskModelSelection(catalog)
  const targetKey = shallowRef('global')
  const drafts = useChatDrafts({ onChange: vi.fn(), targetKey: computed(() => targetKey.value) })
  const binding = useTaskDraftModelBinding({
    drafts,
    selection,
    conversationModel: () => null,
    isModelCatalogReady: computed(() => !catalog.isLoadingModelCatalog.value && catalog.models.value.length > 0),
  })
  const commands = useTaskModelPersistence({
    activeConversationId: shallowRef(null),
    api: {} as LocalChatApi['conversations'],
    applyConversation: vi.fn(),
    drafts,
    onError: vi.fn(),
    selection,
  })
  const confirmOpen = (value: BuddyComposerDraftModelSelection | null, submitted = drafts.snapshot(targetKey.value)) => {
    drafts.confirmOpen(submitted, {
      content: createBuddyUserContent('saved input'),
      draftId: submitted.draftId,
      executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      modelSelection: value,
      revision: 0,
      scope: submitted.targetKey === 'global' ? { kind: 'global' } : { kind: 'space', spaceId: 'space-1' },
      updatedAt: '2026-09-08T00:00:00.000Z',
    })
    binding.restoreOpenedDraft(submitted.targetKey)
  }
  return { binding, catalog, commands, confirmOpen, drafts, selection, setDefaultModel, targetKey }
}

function modelSelection(modelId: string): BuddyComposerDraftModelSelection {
  return { modelId, providerId: 'provider', reasoning: 'medium', serviceTier: null }
}

function model(modelId: string): LocalRuntimeModelOption {
  return {
    available: true,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilityOverrides: null,
    fileInputMimeTypes: [],
    sourceCapabilities: { image: false, reasoningOptions: ['off', 'medium', 'high'] },
    api: 'openai-completions',
    capabilities: ['text', 'reasoning'],
    contextWindow: 4096,
    displayName: modelId,
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: '2026-09-08T00:00:00.000Z',
    maxTokens: 1024,
    modelId,
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId: 'provider',
    reasoningOptions: ['off', 'medium', 'high'],
    serviceTiers: [{ displayName: 'Fast', id: 'priority' }],
    source: 'builtin',
    sourceContextWindow: 4096,
    sourceMaxTokens: 1024,
    sourceParametersUpdated: false,
  }
}
