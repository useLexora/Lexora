import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyComposerDraftModelSelection } from '@buddy-shared/conversation/composerDraft'
import type { ConversationModelControls, LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, shallowRef } from 'vue'
import { useModelProvidersStore } from '@/modules/models'
import { useChatDrafts } from '../useChatDrafts'
import { useTaskActorModel } from '../useTaskActorModel'
import { useTaskDraftModelBinding } from '../useTaskDraftModelBinding'
import { useTaskModelPersistence } from '../useTaskModelPersistence'
import { useTaskModelSelection } from '../useTaskModelSelection'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('draft-owned task model configuration', () => {
  it('keeps explicit model overrides with the structured actor target and clears them when the target changes', () => {
    const drafts = useChatDrafts({ onChange: () => {}, targetKey: computed(() => 'global'), defaultActorId: () => 'main' })
    const contentFor = (...actorIds: string[]) => ({ ...createBuddyUserContent(), body: [{ type: 'paragraph' as const, content: actorIds.map(actorId => ({ type: 'actor_ref' as const, actorId, name: `Name ${actorId}` })) }] })
    drafts.setModelSelection(modelSelection('model-1'))
    drafts.setUserContent(contentFor('actor-a'))
    expect(drafts.modelSelection.value).toBeNull()
    drafts.setModelSelection(modelSelection('model-2'))
    drafts.setUserContent({ ...contentFor('actor-a'), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'actor-a', name: 'Renamed actor' }, { type: 'text', text: 'Please help' }] }] })
    expect(drafts.modelSelection.value).toEqual(modelSelection('model-2'))
    drafts.setUserContent(contentFor('actor-a', 'actor-b'))
    expect(drafts.modelSelection.value).toBeNull()
    const submitted = drafts.snapshot('global')
    drafts.confirmOpen(submitted, { content: contentFor('actor-a'), draftId: submitted.draftId, executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, modelSelection: modelSelection('model-2'), revision: 0, scope: { kind: 'global' }, updatedAt: '2026-10-12T00:00:00.000Z' })
    expect(drafts.modelSelection.value).toEqual(modelSelection('model-2'))
    expect(drafts.acknowledgeSend({ draftId: submitted.draftId, sourceRevision: 0, committedRevision: 1 }, 'global')).toBe(true)
    expect(drafts.modelSelection.value).toBeNull()
  })
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

  it('displays the inherited default without persisting an explicit draft override', async () => {
    const fixture = await createFixture()
    const initial = fixture.drafts.snapshot('global')
    fixture.binding.restoreScope()
    await fixture.catalog.loadModelCatalog(true)

    expect(fixture.drafts.snapshot('global')).toEqual(initial)
    expect(fixture.binding.initialModelSelection('global')).toBeNull()
    fixture.confirmOpen(fixture.binding.initialModelSelection('global'))
    expect(fixture.drafts.modelSelection.value).toBeNull()
    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-1'))
  })

  it('keeps the actor default when reopening a task without a member override', async () => {
    const fixture = await createFixture(modelSelection('model-2'))
    fixture.confirmOpen(null)
    fixture.binding.restoreScope(null)
    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-2'))
    expect(fixture.drafts.modelSelection.value).toBeNull()
    await fixture.commands.setChatEffort('high')
    expect(fixture.drafts.modelSelection.value).toEqual({ ...modelSelection('model-2'), reasoning: 'high' })
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

describe('input actor model selection', () => {
  it('addresses one mentioned actor without persisting a member or changing the running actor', async () => {
    const fixture = await createControlsFixture()
    fixture.address('actor-c', false)
    await nextTick()
    await fixture.controls.refresh()
    expect(fixture.controls.target()).toEqual({ actorId: 'actor-c' })
    await fixture.commands.selectChatModel('provider:model-1')
    expect(fixture.next.drafts.modelSelection.value).toEqual(modelSelection('model-1'))
    expect(fixture.read().next).toEqual({ actorId: 'actor-c', isMember: false, modelSelection: modelSelection('model-2') })
    expect(fixture.read().current?.modelSelection).toEqual(modelSelection('model-1'))
    expect(fixture.mainActor()).toBe('actor-b')
  })

  it('saves model, effort and service tier to the input actor and draft', async () => {
    const fixture = await createControlsFixture()
    expect(fixture.next.selection.selectedModelId.value).toBe('provider:model-2')
    await fixture.commands.setChatEffort('high')
    await fixture.commands.setChatServiceTier('priority')
    expect(fixture.read().next.modelSelection).toEqual({ ...modelSelection('model-2'), reasoning: 'high', serviceTier: 'priority' })
    expect(fixture.next.drafts.modelSelection.value).toEqual(fixture.read().next.modelSelection)
    expect(fixture.read().current?.modelSelection).toEqual(modelSelection('model-1'))
    expect(fixture.controls.target()).toEqual({ actorId: 'actor-b' })
  })

  it('does not reuse an addressed member snapshot from another task while its model is loading', async () => {
    const fixture = await createControlsFixture()
    fixture.address('actor-c', true)
    await nextTick()
    await fixture.controls.refresh()
    const release = fixture.holdNextRead()
    fixture.openConversation('other-task')
    await nextTick()
    expect(fixture.controls.canUpdate()).toBe(false)
    expect(fixture.controls.persistTarget()).toBe(false)
    expect(fixture.controls.isLoading.value).toBe(true)
    release()
    await fixture.controls.refresh()
    expect(fixture.controls.canUpdate()).toBe(true)
  })

  it('ignores a late model read after the addressed actor changes', async () => {
    const fixture = await createControlsFixture()
    const release = fixture.holdNextRead()
    const oldRead = fixture.controls.refresh()
    fixture.address('actor-c', true)
    await nextTick()
    await fixture.controls.refresh()
    await fixture.commands.setChatEffort('high')
    release()
    await oldRead

    expect(fixture.next.selection.currentSelection()).toEqual({ ...modelSelection('model-2'), reasoning: 'high' })
    expect(fixture.controls.target()).toEqual({ actorId: 'actor-c' })
    expect(fixture.next.drafts.modelSelection.value).toEqual({ ...modelSelection('model-2'), reasoning: 'high' })
    expect(fixture.controls.isLoading.value).toBe(false)
  })
})

async function createControlsFixture(nextActorId = 'actor-b') {
  const next = await createFixture(modelSelection('model-2'))
  next.confirmOpen(null)
  const activeConversation = shallowRef<LocalConversation>({ id: 'conversation', buddyId: nextActorId, activeBranchId: 'branch', approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, title: null, spaceId: null, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z', deletedAt: null })
  const addressedActorId = shallowRef<string | null>(null)
  let remote: ConversationModelControls = { current: { runId: 'run-a', actorId: 'actor-a', modelSelection: modelSelection('model-1') }, next: { actorId: nextActorId, isMember: true, modelSelection: modelSelection('model-2') } }
  let barrier: Promise<void> | null = null
  const api = {
    getModelControls: async () => {
      const value = structuredClone(remote)
      const pending = barrier
      barrier = null
      await pending
      return value
    },
    onChanged: () => () => {},
    async setModelSelection(_id: string, selection: LocalConversation['modelSelection'], target?: { actorId?: string }) {
      if (target?.actorId !== remote.next.actorId)
        throw new Error('Invalid input actor')
      remote = { ...remote, next: { ...remote.next, modelSelection: selection } }
      return { ...activeConversation.value, modelSelection: remote.next.modelSelection }
    },
  }
  const onError = (error: unknown) => {
    throw error
  }
  const controls = useTaskActorModel({ activeConversation, api, draftBuddyId: shallowRef(null), addressedActorId, restoreModel: selection => next.selection.restoreConversationModelSelection(next.drafts.modelSelection.value ?? selection), onError })
  const commands = useTaskModelPersistence({ activeConversationId: computed(() => activeConversation.value.id), api, applyConversation: conversation => activeConversation.value = conversation, drafts: next.drafts, selection: next.selection, target: controls.target, canUpdate: controls.canUpdate, persistTarget: controls.persistTarget, onPersisted: controls.refresh, onError })
  await controls.refresh()
  cleanups.push(() => {
    controls.dispose()
    next.binding.dispose()
    next.selection.dispose()
    next.catalog.dispose()
  })
  return {
    next,
    controls,
    commands,
    read: () => remote,
    mainActor: () => activeConversation.value.buddyId,
    openConversation(id: string) {
      remote = { ...remote, current: null }
      activeConversation.value = { ...activeConversation.value, id }
    },
    address(actorId: string, isMember: boolean) {
      remote = { ...remote, next: { actorId, isMember, modelSelection: modelSelection('model-2') } }
      addressedActorId.value = actorId
    },
    holdNextRead() {
      const gate = Promise.withResolvers<void>()
      barrier = gate.promise
      return () => gate.resolve()
    },
  }
}

async function createFixture(actorModel: BuddyComposerDraftModelSelection | null = null) {
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
    conversationModel: () => actorModel,
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
