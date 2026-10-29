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
  it('restores saved scope models without overwriting defaults changed by the user', async () => {
    const fixture = await createFixture()
    const saved = { ...modelSelection('model-1'), reasoning: 'high' as const, serviceTier: 'priority' as const }
    fixture.confirmOpen(saved)
    await fixture.catalog.loadModelCatalog(true)

    expect(fixture.selection.currentSelection()).toEqual(saved)
    expect(fixture.drafts.modelSelection.value).toEqual(saved)
    expect(fixture.selection.selectedModelId.value).toBe('provider:model-1')
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(true)
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-1')

    fixture.targetKey.value = 'space:space-1'
    fixture.binding.restoreScope()
    await fixture.commands.selectChatModel('provider:model-2')
    fixture.confirmOpen(modelSelection('model-2'))
    fixture.targetKey.value = 'global'
    fixture.binding.restoreScope()

    expect(fixture.selection.currentSelection()).toEqual(saved)
    expect(fixture.drafts.modelSelection.value).toEqual(saved)
    expect(fixture.catalog.defaultModelId.value).toBe('provider:model-2')
    fixture.targetKey.value = 'space:space-1'
    fixture.binding.restoreScope()
    expect(fixture.selection.currentSelection()).toEqual(modelSelection('model-2'))
    expect(fixture.drafts.modelSelection.value).toEqual(modelSelection('model-2'))
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

describe('model persistence target isolation', () => {
  it.each(['conversation', 'actor'] as const)('keeps failed saves with their %s and allows retrying that target', async (changedTarget) => {
    const fixture = await createPendingPersistenceFixture()
    const failedSave = fixture.commands.selectChatModel('provider:model-2')
    await nextTick()
    const error = new Error('Model save failed')
    fixture.complete('conversation-a', 'actor-a', error)
    await failedSave
    expect(await fixture.commands.flushModelSelection()).toBe(false)
    expect(fixture.next.drafts.modelSelection.value).toEqual(modelSelection('model-2'))

    fixture.open(changedTarget === 'conversation' ? 'conversation-b' : 'conversation-a', changedTarget === 'actor' ? 'actor-b' : 'actor-a')
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    expect(fixture.error.value).toBeNull()
    expect(fixture.commands.isUpdating.value).toBe(false)

    fixture.open('conversation-a', 'actor-a')
    expect(await fixture.commands.flushModelSelection()).toBe(false)
    expect(fixture.error.value).toBe(error)
    expect(fixture.next.drafts.modelSelection.value).toEqual(modelSelection('model-2'))
    const retry = fixture.commands.selectChatModel('provider:model-2')
    await nextTick()
    expect(fixture.commands.isUpdating.value).toBe(true)
    fixture.complete('conversation-a', 'actor-a')
    await retry
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    expect(fixture.saved.get('conversation-a:actor-a')).toEqual(modelSelection('model-2'))
    expect(fixture.commands.isUpdating.value).toBe(false)
  })

  it('binds a pending flush to its original target while another task saves independently', async () => {
    const fixture = await createPendingPersistenceFixture()
    const firstSave = fixture.commands.selectChatModel('provider:model-2')
    const firstFlush = fixture.commands.flushModelSelection()
    let firstFlushFinished = false
    void firstFlush.then(() => firstFlushFinished = true)
    fixture.open('conversation-b', 'actor-a')
    expect(fixture.commands.isUpdating.value).toBe(false)
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    const secondSave = fixture.commands.setChatEffort('high')
    await nextTick()
    fixture.complete('conversation-b', 'actor-a')
    await secondSave
    const secondModel = fixture.next.drafts.modelSelection.value
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    expect(fixture.saved.get('conversation-b:actor-a')).toEqual(secondModel)
    expect(firstFlushFinished).toBe(false)
    expect(fixture.visibleConversation.value?.id).toBe('conversation-b')
    expect(fixture.refreshed).toEqual(['conversation-b:actor-a'])

    fixture.complete('conversation-a', 'actor-a', new Error('First task failed'))
    await firstSave
    expect(await firstFlush).toBe(false)
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    expect(fixture.next.drafts.modelSelection.value).toEqual(secondModel)
    expect(fixture.error.value).toBeNull()
    expect(fixture.visibleConversation.value?.id).toBe('conversation-b')
    expect(fixture.refreshed).toEqual(['conversation-b:actor-a'])
  })

  it('does not apply a late success or clear the pending save of another actor', async () => {
    const fixture = await createPendingPersistenceFixture()
    const firstSave = fixture.commands.selectChatModel('provider:model-2')
    await fixture.commands.selectChatModel('provider:model-1')
    expect(fixture.next.drafts.modelSelection.value).toEqual(modelSelection('model-2'))
    fixture.open('conversation-a', 'actor-b')
    const secondSave = fixture.commands.setChatServiceTier('priority')
    await nextTick()
    fixture.complete('conversation-a', 'actor-a')
    await firstSave
    expect(fixture.commands.isUpdating.value).toBe(true)
    expect(fixture.visibleConversation.value).toBeNull()
    expect(fixture.refreshed).toEqual([])
    expect(fixture.next.drafts.modelSelection.value?.serviceTier).toBe('priority')

    fixture.complete('conversation-a', 'actor-b')
    await secondSave
    expect(await fixture.commands.flushModelSelection()).toBe(true)
    expect(fixture.commands.isUpdating.value).toBe(false)
    expect(fixture.saved.get('conversation-a:actor-a')).toEqual(modelSelection('model-2'))
    expect(fixture.saved.get('conversation-a:actor-b')?.serviceTier).toBe('priority')
    expect(fixture.refreshed).toEqual(['conversation-a:actor-b'])
  })

  it('keeps the save pending until the task model settles when remembering the default fails first', async () => {
    const fixture = await createPendingPersistenceFixture()
    const selectModel = fixture.next.selection.selectModel
    vi.spyOn(fixture.next.selection, 'selectModel').mockImplementation(async (value) => {
      await selectModel(value)
      throw new Error('Default save failed')
    })
    const pendingSave = fixture.commands.selectChatModel('provider:model-2')
    const pendingFlush = fixture.commands.flushModelSelection()
    let flushed = false
    void pendingFlush.then(() => flushed = true)
    await nextTick()
    await nextTick()
    expect(fixture.commands.isUpdating.value).toBe(true)
    expect(flushed).toBe(false)

    fixture.complete('conversation-a', 'actor-a')
    await pendingSave
    expect(await pendingFlush).toBe(false)
    expect(fixture.commands.isUpdating.value).toBe(false)
    expect(fixture.error.value).toEqual(new Error('Default save failed'))
    expect(fixture.saved.get('conversation-a:actor-a')).toEqual(modelSelection('model-2'))
  })
})

async function createPendingPersistenceFixture() {
  const next = await createFixture()
  const activeConversationId = shallowRef('conversation-a')
  const actorId = shallowRef('actor-a')
  const error = shallowRef<unknown>(null)
  const visibleConversation = shallowRef<LocalConversation | null>(null)
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const saved = new Map<string, LocalConversation['modelSelection']>()
  const refreshed: string[] = []
  const commands = useTaskModelPersistence({
    activeConversationId,
    target: () => ({ actorId: actorId.value }),
    drafts: next.drafts,
    selection: next.selection,
    onError: value => error.value = value,
    applyConversation: value => visibleConversation.value = value,
    onPersisted: async () => { refreshed.push(`${activeConversationId.value}:${actorId.value}`) },
    api: {
      async setModelSelection(conversationId, selection, target) {
        const key = `${conversationId}:${target?.actorId}`
        const gate = Promise.withResolvers<void>()
        pending.set(key, gate)
        await gate.promise
        saved.set(key, selection)
        return { id: conversationId, buddyId: target?.actorId ?? 'actor-a', activeBranchId: 'branch', approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: selection, title: null, spaceId: null, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z', deletedAt: null }
      },
    },
  })
  function open(conversationId: string, nextActorId: string) {
    activeConversationId.value = conversationId
    actorId.value = nextActorId
    next.targetKey.value = `${conversationId}:${nextActorId}`
    next.binding.restoreScope()
    error.value = null
  }
  open('conversation-a', 'actor-a')
  cleanups.push(next.binding.dispose, next.selection.dispose, next.catalog.dispose)
  return {
    next,
    commands,
    error,
    visibleConversation,
    refreshed,
    saved,
    open,
    complete(conversationId: string, targetActorId: string, failure?: Error) {
      const gate = pending.get(`${conversationId}:${targetActorId}`)
      if (!gate)
        throw new Error('Missing pending model save')
      if (failure)
        gate.reject(failure)
      else
        gate.resolve()
    },
  }
}

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
      setDefaultModel: async (value: Parameters<LocalChatApi['providers']['setDefaultModel']>[0]) => value,
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
  return { binding, catalog, commands, confirmOpen, drafts, selection, targetKey }
}

function modelSelection(modelId: string): BuddyComposerDraftModelSelection {
  return { modelId, providerId: 'provider', reasoning: 'medium', serviceTier: null }
}

function model(modelId: string): LocalRuntimeModelOption {
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
