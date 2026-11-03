import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyUserMessageContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalStartTurnRequest } from '@buddy-shared/conversation/chatApi'
import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'
import type { BuddyComposerResourceAccept } from '@buddy-shared/conversation/composerResource'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'

import type { UseTaskCapabilityOptions } from '../useTaskCapability'
import { actorThreadId } from '@buddy-shared/conversation/actorThread'
import { ServiceHost } from '@buddy-shared/lifecycle/ServiceHost'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { computed, effectScope } from 'vue'
import { createBuddyUserContent } from '../../../../../shared/conversation/buddyUserContent'

import { useDesktopAppState } from '../../../../app/bootstrap/useDesktopAppState'
import { useTaskIndex } from '../task-index/useTaskIndex'
import { useTaskCapability } from '../useTaskCapability'

describe('useTaskCapability', () => {
  it('binds current actor-child context to the execution instead of the actors public history', async () => {
    const api = createBranchingDesktopApi()
    const publicRun = { ...queuedRun(), id: 'public-run', branchId: 'branch-root', status: 'completed' as const }
    const timeline = await api.localChat.conversations.listTimeline({ conversationId: 'conversation-1', branchId: 'branch-root' })
    vi.mocked(api.localChat.conversations.listTimeline).mockResolvedValue({
      ...timeline,
      runs: [publicRun],
      runEvents: [{
        runId: publicRun.id,
        sequence: 1,
        type: 'context.usage.updated',
        createdAt: '2026-08-19T00:00:00.000Z',
        payload: { model: 'model-1', provider: 'provider-1', totalTokens: 900, messageTokens: 900, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 },
      }],
    })
    const models = await api.localChat.providers.listModels()
    vi.mocked(api.localChat.providers.listModels).mockResolvedValue(models.map(model => ({ ...model, type: 'chat', sourceType: 'chat', typeOverride: null })))
    let child: LocalExecution = {
      runId: 'isolated-child',
      threadId: 'isolated-thread',
      rootRunId: 'root',
      parentRunId: 'root',
      buddyId: 'default',
      buddyName: 'Actor',
      ordinal: 1,
      kind: 'actor_child',
      phase: 'working',
      status: 'running',
      startedAt: '2026-08-19T00:00:00.000Z',
      completedAt: null,
      updatedAt: '2026-08-19T00:00:00.000Z',
      progress: null,
      toolCount: 0,
      usage: null,
      stopping: false,
      task: 'Private task',
      waitingFor: null,
      activeChildren: 0,
      canCancel: true,
      canSend: true,
      canAnswer: false,
      cleanup: 'pending',
      errorCode: null,
      affectedResources: [],
      questions: [],
    }
    const root: LocalExecution = { ...child, runId: 'root', rootRunId: 'root', parentRunId: null, kind: 'root', buddyId: 'caller' }
    api.localChat.executions.list = async () => [{ ...root }, { ...child }]
    api.localChat.executions.inputs = async () => ({ inputs: [], nextOffset: null })
    let ready = false
    vi.mocked(api.localChat.context.getUsageSnapshot).mockImplementation(async (input) => {
      const identity = { modelId: 'model-1', providerId: 'provider-1', contextWindow: 4096, createdAt: '2026-08-20T00:00:00.000Z' }
      if (input.runId && !ready)
        return { ...identity, status: 'pending' as const, reason: 'unavailable' as const }
      const tokens = input.runId ? 200 : 900
      return { ...identity, status: 'ready' as const, totalTokens: tokens, messageTokens: tokens, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 }
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const scope = effectScope()
    const chat = scope.run(() => createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null }))!
    try {
      await chat.initialize()
      await vi.waitFor(() => expect(chat.workspace.execution.inputExecution.value?.runId).toBe(child.runId))
      await vi.waitFor(() => expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null }))
      expect(vi.mocked(api.localChat.context.getUsageSnapshot).mock.calls.at(-1)?.[0]).toMatchObject({
        actorId: 'default',
        runId: child.runId,
        conversationId: 'conversation-1',
        branchId: 'branch-root',
      })
      ready = true
      child = { ...child, updatedAt: '2026-08-21T00:00:00.000Z' }
      await chat.workspace.executionTree.refresh()
      await vi.waitFor(() => expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 200 }))
    }
    finally {
      chat.dispose()
      scope.stop()
    }
  })

  it.each(['ancestor', 'isolated', 'current'] as const)('scopes idle context events to the active branch and actor thread: %s', async (source) => {
    const api = createBranchingDesktopApi()
    const branches = await api.localChat.conversations.listBranches('conversation-1')
    vi.mocked(api.localChat.conversations.listBranches).mockResolvedValue([...branches, branch('branch-edited', 'branch-root', 'assistant-1', '2026-08-15T00:00:00.000Z')])
    await api.localChat.conversations.activateBranch({ conversationId: 'conversation-1', branchId: 'branch-edited' })
    const models = await api.localChat.providers.listModels()
    vi.mocked(api.localChat.providers.listModels).mockResolvedValue(models.map(model => ({ ...model, type: 'chat', sourceType: 'chat', typeOverride: null })))
    const run = { ...queuedRun(), id: 'run-assistant-1', branchId: source === 'ancestor' ? 'branch-root' : 'branch-edited', status: 'completed' as const, completedAt: '2026-08-19T00:00:03.000Z' }
    const execution: LocalExecution = {
      runId: run.id,
      threadId: source === 'isolated' ? 'isolated-thread' : actorThreadId(run.conversationId, run.buddyId),
      rootRunId: run.id,
      parentRunId: null,
      buddyId: run.buddyId,
      buddyName: 'Actor',
      ordinal: null,
      kind: 'root',
      phase: 'closed',
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      updatedAt: run.completedAt,
      progress: null,
      toolCount: 0,
      usage: null,
      stopping: false,
      task: 'Earlier work',
      waitingFor: null,
      activeChildren: 0,
      canCancel: false,
      canSend: false,
      canAnswer: false,
      cleanup: 'clean',
      errorCode: null,
      affectedResources: [],
      questions: [],
    }
    api.localChat.executions.list = async () => [execution]
    api.localChat.executions.inputs = async () => ({ inputs: [], nextOffset: null })
    vi.mocked(api.localChat.context.getUsageSnapshot).mockResolvedValue({ modelId: 'model-1', providerId: 'provider-1', contextWindow: 4096, createdAt: '2026-08-20T00:00:00.000Z', status: 'ready', totalTokens: 100, messageTokens: 100, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const scope = effectScope()
    const chat = scope.run(() => createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-edited', spaceId: null }))!
    try {
      await chat.initialize()
      await vi.waitFor(() => {
        expect(chat.workspace.executionTree.records.value).toHaveLength(1)
        expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 100 })
      })
      const timeline = await api.localChat.conversations.listTimeline({ conversationId: 'conversation-1', branchId: 'branch-edited' })
      vi.mocked(api.localChat.conversations.listTimeline).mockResolvedValue({
        ...timeline,
        runs: [run],
        runEvents: [
          { runId: run.id, sequence: 1, type: 'context.compaction.completed', createdAt: '2026-08-19T00:00:01.000Z', payload: {} },
          { runId: run.id, sequence: 2, type: 'context.usage.updated', createdAt: '2026-08-19T00:00:02.000Z', payload: { model: 'model-1', provider: 'provider-1', totalTokens: 900, messageTokens: 900, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 } },
        ],
      })
      for (const [listener] of vi.mocked(api.localChat.conversations.onTimelineChanged).mock.calls)
        listener({ sourceId: '00000000-0000-4000-8000-000000000001', revision: 1, conversationId: 'conversation-1', branchId: 'branch-edited' })
      await vi.waitFor(() => expect(chat.workspace.transcript.runSignalEvents.value).toHaveLength(2))
      expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: source === 'current' ? 900 : 100 })
    }
    finally {
      chat.dispose()
      scope.stop()
    }
  })

  it.each([true, false])('revalidates idle context after a maintenance compaction without assuming it affects this thread: %s', async (affectsThread) => {
    const api = createBranchingDesktopApi()
    const timeline = await api.localChat.conversations.listTimeline({ conversationId: 'conversation-1', branchId: 'branch-root' })
    const models = await api.localChat.providers.listModels()
    vi.mocked(api.localChat.providers.listModels).mockResolvedValue(models.map(model => ({ ...model, type: 'chat', sourceType: 'chat', typeOverride: null })))
    let compacted = false
    let settled = false
    vi.mocked(api.localChat.conversations.listTimeline).mockImplementation(async () => ({
      ...timeline,
      runs: compacted ? [{ ...queuedRun(), id: 'maintenance', branchId: 'branch-root', purpose: 'conversation.compaction', status: settled ? 'completed' : 'running', completedAt: settled ? '2026-08-20T00:00:00.000Z' : null }] : [],
      runEvents: compacted ? [{ runId: 'maintenance', sequence: 2, type: 'context.compaction.completed', createdAt: '2026-08-20T00:00:00.000Z', payload: {} }] : [],
    }))
    vi.mocked(api.localChat.context.getUsageSnapshot).mockImplementation(async () => {
      const identity = { modelId: 'model-1', providerId: 'provider-1', contextWindow: 4096, createdAt: '2026-08-20T00:00:01.000Z' }
      return compacted && settled && affectsThread
        ? { ...identity, status: 'pending', reason: 'compaction' }
        : { ...identity, status: 'ready', totalTokens: 100, messageTokens: 100, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 }
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const scope = effectScope()
    const chat = scope.run(() => createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null }))!
    try {
      await chat.initialize()
      await vi.waitFor(() => expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 100 }))
      const previousReads = vi.mocked(api.localChat.context.getUsageSnapshot).mock.calls.length
      compacted = true
      for (const [listener] of vi.mocked(api.localChat.conversations.onTimelineChanged).mock.calls)
        listener({ sourceId: '00000000-0000-4000-8000-000000000001', revision: 1, conversationId: 'conversation-1', branchId: 'branch-root' })
      await vi.waitFor(() => expect(vi.mocked(api.localChat.context.getUsageSnapshot).mock.calls.length).toBeGreaterThan(previousReads))
      expect(chat.workspace.composer.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 100 })
      const readsBeforeCompletion = vi.mocked(api.localChat.context.getUsageSnapshot).mock.calls.length
      settled = true
      for (const [listener] of vi.mocked(api.localChat.conversations.onTimelineChanged).mock.calls)
        listener({ sourceId: '00000000-0000-4000-8000-000000000001', revision: 2, conversationId: 'conversation-1', branchId: 'branch-root' })
      await vi.waitFor(() => expect(vi.mocked(api.localChat.context.getUsageSnapshot).mock.calls.length).toBeGreaterThan(readsBeforeCompletion))
      await vi.waitFor(() => expect(chat.workspace.composer.contextUsage.value).toMatchObject(affectsThread
        ? { status: 'pending', totalTokens: null }
        : { status: 'ready', totalTokens: 100 }))
    }
    finally {
      chat.dispose()
      scope.stop()
    }
  })

  it('binds composer stopping to the chosen actor while other active actors keep branch mutation disabled', async () => {
    const api = createBranchingDesktopApi()
    const main = { ...queuedRun(), id: 'main-active', branchId: 'branch-root' }
    const peer = { ...main, id: 'peer-active', buddyId: 'peer' }
    const timeline = await api.localChat.conversations.listTimeline({ conversationId: 'conversation-1', branchId: 'branch-root' })
    vi.mocked(api.localChat.conversations.listTimeline).mockResolvedValue({ ...timeline, runs: [peer, main] })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const scope = effectScope()
    const chat = scope.run(() => createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null }))!
    await chat.initialize()
    expect(chat.workspace.execution.activeRun.value?.id).toBe(main.id)
    const current = chat.session.activeTask.value!
    const listeners = vi.mocked(api.localChat.conversations.onChanged).mock.calls.map(call => call[0])
    for (const listener of listeners) listener({ ...current, buddyId: 'peer' })
    expect(chat.workspace.execution.activeRun.value?.id).toBe(peer.id)
    vi.mocked(api.localChat.chat.cancel).mockResolvedValue({ ...peer, status: 'cancelled' })
    await chat.workspace.execution.cancelActiveRun()
    expect(api.localChat.chat.cancel).toHaveBeenCalledWith(peer.id)
    expect(chat.workspace.execution.activeRun.value).toBeNull()
    expect(chat.workspace.execution.canMutateBranch.value).toBe(false)
    chat.dispose()
    scope.stop()
  })

  it('updates the loaded conversation scope after a move without replacing its composer draft', async () => {
    const api = createBranchingDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('Unsent work', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsent work' }] }] })
    await chat.flushDrafts()
    const draftId = chat.workspace.composer.draftId.value
    const current = chat.session.activeTask.value!
    const listeners = vi.mocked(api.localChat.conversations.onChanged).mock.calls.map(call => call[0])
    for (const listener of listeners)
      listener({ ...current, spaceId: 'target-space' })
    expect(chat.session.spaceId.value).toBe('target-space')
    expect(chat.session.activeTask.value?.spaceId).toBe('target-space')
    expect(chat.workspace.composer.draftId.value).toBe(draftId)
    expect(JSON.stringify(chat.workspace.composer.composerContent.value)).toContain('Unsent work')
    chat.dispose()
  })

  it('loads conversation content while input restores even when branch loading fails', async () => {
    const api = createBranchingDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const gate = deferred<void>()
    const open = vi.mocked(api.localChat.composerDrafts.open).getMockImplementation()!
    vi.mocked(api.localChat.composerDrafts.open).mockImplementation(async (input) => {
      await gate.promise
      return open(input)
    })
    vi.mocked(api.localChat.conversations.listBranches).mockRejectedValue(new Error('BRANCH_READ_FAILED'))
    const scope = effectScope()
    const chat = scope.run(() => createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null }))!
    let completed = false
    const initialization = chat.initialize().then(() => {
      completed = true
    })
    try {
      await vi.waitFor(() => expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1', 'user-2', 'assistant-2']))
      expect(chat.workspace.restoration.state.value).toBe('restoring')
      expect(completed).toBe(false)
    }
    finally {
      gate.resolve()
      await initialization
      chat.dispose()
      scope.stop()
    }
  })

  it('restores saved attachments when the new-task pane keeps the same draft identity', async () => {
    const api = createDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const draftId = 'stable-new-task'
    const resource = { draftId, resourceId: 'saved-resource', state: 'ready' as const, kind: 'text' as const, attachmentId: 'saved-attachment', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 10, previewUrl: null }
    await api.localChat.composerDrafts.open({ draftId, scope: { kind: 'task', draftId, spaceId: null }, initialContent: { ...createBuddyUserContent('Saved input'), panelResourceIds: [resource.resourceId] }, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null })
    vi.mocked(api.localChat.composerResources.list).mockResolvedValue([resource])
    const chat = createTestTask(api, { draftKey: draftId, conversationId: null, branchId: null, spaceId: null })
    await chat.initialize()
    expect(chat.workspace.composer.draftId.value).toBe(draftId)
    await vi.waitFor(() => expect(chat.workspace.composer.resources.value.map(entry => entry.resource)).toEqual([resource]))
    expect(await chat.flushDrafts()).toBe(true)
    expect((await api.localChat.composerDrafts.get(draftId)).content.panelResourceIds).toEqual([resource.resourceId])
    chat.dispose()
  })

  it('waits for the first submission receipt before closing and unlocks input when closing is cancelled', async () => {
    const api = createDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('Keep this input', null)
    const original = api.localChat.chat.startTurn.getMockImplementation() as LexoraDesktopApi['localChat']['chat']['startTurn']
    const gate = deferred<void>()
    vi.mocked(api.localChat.chat.startTurn).mockImplementation(async (input) => {
      await gate.promise
      return original(input)
    })
    const sending = chat.workspace.execution.send('Keep this input')
    await vi.waitFor(() => expect(chat.workspace.execution.isSending.value).toBe(true))
    const closing = chat.prepareClose()
    expect(chat.workspace.status.isClosing.value).toBe(true)
    expect(chat.workspace.execution.canSend.value).toBe(false)
    gate.resolve()
    expect(await sending).toBe(true)
    expect(await closing).toBe(true)
    expect(chat.workspace.session.activeConversationId.value).toBe('conversation-1')
    expect(chat.workspace.execution.activeRun.value?.id).toBe('run-1')
    expect(chat.workspace.composer.draft.value).toBe('')
    chat.cancelClose()
    chat.workspace.composer.updateComposerContent('Input after cancellation', null)
    expect(chat.workspace.status.isClosing.value).toBe(false)
    expect(await chat.flushDrafts()).toBe(true)
    expect((await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)).content).toEqual(createBuddyUserContent('Input after cancellation'))
    chat.dispose()
  })

  it('displays the first available model without persisting an inherited Draft selection', async () => {
    const api = createDesktopApi()
    const models = await api.localChat.providers.listModels()
    vi.mocked(api.localChat.providers.listModels).mockReset().mockResolvedValueOnce([]).mockResolvedValue(models)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const appState = useDesktopAppState({ api })
    const chat = createTaskCapability(api, appState)
    await appState.initialize()
    await appState.refreshRuntimeDependentState(new ServiceHost())
    await chat.initialize()
    const draftId = chat.workspace.composer.draftId.value
    expect((await api.localChat.composerDrafts.get(draftId)).modelSelection).toBeNull()
    expect(chat.workspace.composer.selectedModelId.value).toBeNull()

    await appState.stores.modelProviders.loadModelCatalog(true)

    expect(chat.workspace.composer.selectedModelId.value).toBe('provider-1:model-1')
    expect(await chat.flushDrafts()).toBe(true)
    expect((await api.localChat.composerDrafts.get(draftId)).modelSelection).toBeNull()
    chat.workspace.composer.updateComposerContent('first configured task', null)
    expect(await chat.workspace.execution.send('first configured task')).toBe(true)
  })

  it.each([
    { modelId: 'model-2', reasoning: 'xhigh' as const, serviceTier: null },
    { modelId: 'model-2', reasoning: 'medium' as const, serviceTier: 'priority' as const },
    { modelId: 'removed-model', reasoning: 'medium' as const, serviceTier: null },
  ])('preserves unavailable saved model parameters and waits for an explicit supported selection: %j', async (selection) => {
    const api = createDesktopApi()
    const modelSelection = { providerId: 'provider-1', ...selection }
    const remote = await api.localChat.composerDrafts.open({
      draftId: 'saved-global-draft',
      initialContent: createBuddyUserContent('saved input'),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: modelSelection,
      scope: { kind: 'global' },
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()

    expect(chat.workspace.composer.selectedModelId.value).toBe(`provider-1:${selection.modelId}`)
    expect(chat.workspace.composer.selectedEffort.value).toBe(selection.reasoning)
    expect(chat.workspace.composer.selectedServiceTier.value).toBe(selection.serviceTier)
    expect(chat.workspace.execution.canSend.value).toBe(false)
    expect(await chat.flushDrafts()).toBe(true)
    expect(await chat.workspace.execution.send('saved input')).toBe(false)
    expect((await api.localChat.composerDrafts.get(remote.draftId)).modelSelection).toEqual(modelSelection)
    expect(api.localChat.providers.setDefaultModel).not.toHaveBeenCalled()

    await chat.workspace.composer.selectModel('provider-1:model-1')
    expect(chat.workspace.execution.canSend.value).toBe(true)
    expect(await chat.workspace.execution.send('saved input')).toBe(true)
  })

  it('recovers a failed initial Draft open on concurrent Runtime ready refreshes', async () => {
    const api = createDesktopApi()
    vi.mocked(api.localChat.conversations.list).mockReset().mockResolvedValue([])
    vi.mocked(api.localChat.composerDrafts.open).mockRejectedValueOnce(new Error('Runtime unavailable'))
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('typed after Runtime failure', null)
    const draftId = chat.workspace.composer.draftId.value
    expect(await chat.flushDrafts()).toBe(false)

    const first = chat.refreshRuntimeDependentState()
    const second = chat.refreshRuntimeDependentState()
    await Promise.all([first, second])

    expect(chat.workspace.composer.draftId.value).toBe(draftId)
    expect(chat.workspace.composer.draft.value).toBe('typed after Runtime failure')
    expect(await chat.flushDrafts()).toBe(true)
    expect(await chat.workspace.execution.send('typed after Runtime failure')).toBe(true)
  })

  it('returns a late file selection to the originating draft without changing the newly opened conversation', async () => {
    const api = createDesktopApi()
    const selected = deferred<Awaited<ReturnType<typeof api.localChat.composerResources.selectFiles>>>()
    vi.mocked(api.localChat.conversations.list).mockReset().mockResolvedValue([conversationSummary('idle')])
    vi.mocked(api.localChat.composerResources.selectFiles).mockImplementation(() => selected.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('source draft', null)
    const sourceDraftId = chat.workspace.composer.draftId.value

    const selecting = chat.workspace.composer.selectAttachments()
    await vi.waitUntil(() => chat.workspace.composer.isSelectingFiles.value)
    await chat.session.openTask('conversation-background')
    chat.workspace.composer.updateComposerContent('destination draft', null)
    const attachment = {
      ...inputAttachment('selected-image'),
      draftId: sourceDraftId,
      kind: 'image' as const,
      resourceId: 'resource-selected',
      state: 'ready' as const,
    }
    selected.resolve([attachment])
    await selecting

    expect(chat.workspace.composer.draft.value).toBe('destination draft')
    await chat.session.startTask(null)
    expect(chat.workspace.composer.draft.value).toBe('source draft')
    expect(chat.workspace.composer.resources.value.map(entry => entry.resource)).toEqual([attachment])
    expect(chat.workspace.composer.composerContent.value).toMatchObject({ attrs: { panelResourceIds: ['resource-selected'] } })
  })

  it('surfaces an actionable message when Pi session storage is unavailable', async () => {
    const api = createDesktopApi()
    vi.mocked(api.localChat.chat.startTurn).mockImplementation(async input => ({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      draftReceipt: {
        committedRevision: input.expectedRevision + 1,
        draftId: input.draftId,
        sourceRevision: input.expectedRevision,
      },
      run: {
        ...queuedRun(),
        completedAt: '2026-08-17T00:00:01.000Z',
        errorCode: 'SESSION_STORAGE_UNAVAILABLE',
        id: 'run-session-storage-failed',
        status: 'failed',
      },
      runId: 'run-session-storage-failed',
    }))
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('already accepted input', null)
    const sourceDraftId = chat.workspace.composer.draftId.value

    await expect(chat.workspace.execution.send('already accepted input')).resolves.toBe(true)
    expect(chat.workspace.composer.draft.value).toBe('')
    expect(chat.workspace.composer.draftId.value).toBe(sourceDraftId)
    expect(chat.workspace.status.errorMessage.value).toBe('无法读取 Buddy 任务存储，请检查本地数据目录权限后重试')
  })

  it('submits edits made during save confirmation and preserves edits made before the receipt returns', async () => {
    const api = createDesktopApi()
    const saving = deferred<void>()
    const accepting = deferred<void>()
    const saveDraft = vi.mocked(api.localChat.composerDrafts.save).getMockImplementation()!
    vi.mocked(api.localChat.composerDrafts.save).mockImplementation(async (value) => {
      await saving.promise
      return saveDraft(value)
    })
    const startTurn = vi.mocked<LexoraDesktopApi['localChat']['chat']['startTurn']>(api.localChat.chat.startTurn).getMockImplementation()!
    let submitted: LocalComposerDraft | null = null
    vi.mocked(api.localChat.chat.startTurn).mockImplementation(async (input) => {
      submitted = await api.localChat.composerDrafts.get(input.draftId)
      const result = await startTurn(input)
      await accepting.promise
      return result
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { draftKey: 'editing-during-send', conversationId: null, branchId: null, spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('before save', null)
    const sourceDraftId = chat.workspace.composer.draftId.value

    const sending = chat.workspace.execution.send('before save')
    await vi.waitUntil(() => vi.mocked(api.localChat.composerDrafts.save).mock.calls.length > 0)
    chat.workspace.composer.updateComposerContent('newer edit', null)
    saving.resolve()
    await vi.waitFor(() => expect(submitted).toMatchObject({ content: createBuddyUserContent('newer edit') }))
    chat.workspace.composer.updateComposerContent('newer unsent input', null)
    accepting.resolve()

    await expect(sending).resolves.toBe(true)
    expect(chat.workspace.composer.draftId.value).toBe(sourceDraftId)
    expect(chat.workspace.composer.draft.value).toBe('newer unsent input')
  })

  it('does not append a late picker result after the same draft has been sent and cleared', async () => {
    const api = createDesktopApi()
    const selected = deferred<Awaited<ReturnType<typeof api.localChat.composerResources.selectFiles>>>()
    vi.mocked(api.localChat.composerResources.selectFiles).mockImplementation(() => selected.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('sent before the picker closed', null)
    const sourceDraftId = chat.workspace.composer.draftId.value
    const selecting = chat.workspace.composer.selectAttachments()
    await vi.waitUntil(() => chat.workspace.composer.isSelectingFiles.value)

    await expect(chat.workspace.execution.send('sent before the picker closed')).resolves.toBe(true)
    expect(chat.workspace.composer.draftId.value).toBe(sourceDraftId)
    chat.workspace.composer.updateComposerContent('next input', null)
    selected.resolve([{
      ...inputAttachment('late-file'),
      draftId: sourceDraftId,
      kind: 'image',
      resourceId: 'late-resource',
      state: 'ready',
    }])
    await selecting

    expect(chat.workspace.composer.draft.value).toBe('next input')
    expect(chat.workspace.composer.composerContent.value).toMatchObject({
      attrs: { panelResourceIds: [] },
      content: [{ content: [{ text: 'next input', type: 'text' }] }],
    })
  })

  it.each(['accepted', 'failed'] as const)('keeps the current task when a previous send is %s after navigation', async (outcome) => {
    const api = createDesktopApi()
    const pendingTurn = deferred<Awaited<ReturnType<typeof api.localChat.chat.startTurn>>>()
    const conversationB = {
      ...conversationSummary('idle'),
      activeBranchId: 'branch-b',
      id: 'conversation-b',
      spaceId: 'space-b',
      title: 'Conversation B',
    }
    vi.mocked(api.localChat.conversations.list).mockReset().mockResolvedValue([conversationB])
    vi.mocked(api.localChat.spaces.list).mockResolvedValue([{
      icon: 'folder',
      iconColor: 'default',
      activeRunCount: 0,
      additionalDirectories: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      id: 'space-b',
      memoryScope: 'personal_and_space',
      name: 'Space B',
      primaryDirectory: null,
      revokedAt: null,
      updatedAt: '2026-08-14T00:00:00.000Z',
    }])
    api.localChat.chat.startTurn.mockImplementation(() => pendingTurn.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('hello from A', null)

    const sending = chat.workspace.execution.send('hello from A')
    await vi.waitUntil(() => api.localChat.chat.startTurn.mock.calls.length === 1)
    expect(chat.workspace.composer.canUpdatePermissionSettings.value).toBe(false)
    await expect(chat.workspace.composer.setPermissionMode('full_access')).resolves.toBe(false)
    await chat.session.openTask('conversation-b')
    const request = api.localChat.chat.startTurn.mock.calls[0]![0]
    if (outcome === 'failed') {
      pendingTurn.reject(new Error('conversation A failed'))
    }
    else {
      pendingTurn.resolve({
        branchId: 'branch-a',
        conversationId: 'conversation-a',
        draftReceipt: {
          committedRevision: request.expectedRevision + 1,
          draftId: request.draftId,
          sourceRevision: request.expectedRevision,
        },
        run: {
          ...queuedRun(),
          branchId: 'branch-a',
          conversationId: 'conversation-a',
          id: 'run-a',
          triggeringMessageId: 'message-a',
          approvalPolicy: 'policy',
          executionProfile: 'workspace_write',
          purpose: 'chat',
        },
        runId: 'run-a',
      })
    }

    await expect(sending).resolves.toBe(outcome === 'accepted')
    expect(chat.session.activeTaskId.value).toBe('conversation-b')
    expect(chat.session.spaceId.value).toBe('space-b')
    expect(chat.workspace.status.errorMessage.value).toBeNull()
  })

  it('edits a visible user input on a new sibling branch', async () => {
    const api = createBranchingDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('ordinary pending input', null)
    const ordinaryDraftId = chat.workspace.composer.draftId.value

    await expect(chat.workspace.execution.editUserMessage('user-2')).resolves.toBe(true)

    expect(chat.workspace.execution.editingMessageId.value).toBe('user-2')
    expect(chat.workspace.composer.draft.value).toBe('user-2')
    expect(api.localChat.chat.editUserMessage).not.toHaveBeenCalled()
    expect(chat.workspace.execution.cancelEditUserMessage()).toBe(true)
    expect(chat.workspace.execution.editingMessageId.value).toBeNull()
    expect(chat.workspace.composer.draftId.value).toBe(ordinaryDraftId)
    expect(chat.workspace.composer.draft.value).toBe('ordinary pending input')

    await expect(chat.workspace.execution.editUserMessage('user-2')).resolves.toBe(true)

    const payload = {
      content: 'edited follow-up',
      userContent: createBuddyUserContent('edited follow-up'),
    }
    const submitting = chat.workspace.execution.submitEditedMessage(payload)
    await expect(chat.workspace.execution.submitEditedMessage(payload)).resolves.toBe(false)
    await expect(submitting).resolves.toBe(true)

    expect(api.localChat.chat.editUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conversationId: 'conversation-1',
      userMessageId: 'user-2',
    }))
    expect(chat.workspace.session.activeBranchId.value).toBe('branch-edited')
    expect(chat.workspace.transcript.branches.value.map(branch => branch.id)).toEqual(['branch-root', 'branch-edited'])
    expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
  })

  it('keeps the current task when an earlier branch activation completes', async () => {
    const api = createBranchingDesktopApi()
    vi.mocked(api.localChat.conversations.listBranches).mockResolvedValue([
      branch('branch-root', null, null, '2026-08-14T00:00:00.000Z'),
      branch('branch-fork', 'branch-root', 'assistant-1', '2026-08-15T00:00:00.000Z'),
    ])
    const pending = deferred<void>()
    const activate = api.localChat.conversations.activateBranch
    api.localChat.conversations.activateBranch = vi.fn(async (input) => {
      await pending.promise
      return activate(input)
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()

    const activating = chat.workspace.transcript.activateBranch('branch-fork')
    await chat.session.startTask(null)
    chat.workspace.composer.updateComposerContent('new task input', null)
    const currentDraftId = chat.workspace.composer.draftId.value
    pending.resolve()
    await expect(activating).resolves.toBe(true)

    expect(chat.session.activeTaskId.value).toBeNull()
    expect(chat.workspace.session.activeBranchId.value).toBeNull()
    expect(chat.workspace.transcript.messages.value).toEqual([])
    expect(chat.workspace.composer.draftId.value).toBe(currentDraftId)
    expect(chat.workspace.composer.draft.value).toBe('new task input')
    expect(chat.workspace.execution.isMutatingBranch.value).toBe(false)
  })

  it('keeps delayed message-edit resources in their owning Draft after navigation', async () => {
    const api = createBranchingDesktopApi()
    const sourceContent: BuddyUserMessageContentV1 = {
      resourceSnapshots: [{ attachmentId: 'source-file', resourceId: 'source-resource' }],
      userContent: {
        body: [{ content: [
          { text: 'source input ', type: 'text' },
          { resourceId: 'source-resource', type: 'resource_ref' },
        ], type: 'paragraph' }],
        panelResourceIds: [],
        version: 1,
      },
    }
    vi.mocked(api.localChat.conversations.listTimeline).mockResolvedValue({
      changeSets: [],
      items: branchTimeline('branch-root').map(item => item.id === 'user-2'
        ? { ...item, content: sourceContent }
        : item),
      nextCursor: null,
      outputs: [],
      runEvents: [],
      runs: [],
    })
    const selected = deferred<Awaited<ReturnType<typeof api.localChat.composerResources.selectSource>>>()
    vi.mocked(api.localChat.composerResources.selectSource).mockReturnValue(selected.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('ordinary pending input', null)
    const ordinaryDraftId = chat.workspace.composer.draftId.value
    const editing = chat.workspace.execution.editUserMessage('user-2')
    await vi.waitUntil(() => vi.mocked(api.localChat.composerResources.selectSource).mock.calls.length === 1)
    const editDraftId = chat.workspace.composer.draftId.value
    expect(editDraftId).not.toBe(ordinaryDraftId)
    expect((await api.localChat.composerDrafts.get(editDraftId)).content).toEqual(createBuddyUserContent('source input '))
    await chat.session.startTask(null)
    chat.workspace.composer.updateComposerContent('new task input', null)
    const currentDraftId = chat.workspace.composer.draftId.value
    selected.resolve({
      ...inputAttachment('copied-file'),
      draftId: editDraftId,
      resourceId: 'copied-resource',
      state: 'ready',
    })
    await expect(editing).resolves.toBe(false)

    expect(chat.session.activeTaskId.value).toBeNull()
    expect(chat.workspace.composer.draftId.value).toBe(currentDraftId)
    expect(chat.workspace.composer.draft.value).toBe('new task input')
    expect(chat.workspace.composer.composerContent.value.attrs?.panelResourceIds).toEqual([])
    expect(chat.workspace.execution.editingMessageId.value).toBeNull()
    expect(chat.workspace.execution.isMutatingBranch.value).toBe(false)
    expect((await api.localChat.composerDrafts.get(ordinaryDraftId)).content).toEqual(createBuddyUserContent('ordinary pending input'))
  })

  it.each([
    { permissions: { approvalPolicy: 'policy', executionProfile: 'read_only' }, pendingModel: false },
    { permissions: { approvalPolicy: 'manual', executionProfile: 'workspace_write' }, pendingModel: false },
    { permissions: { approvalPolicy: 'policy', executionProfile: 'read_only' }, pendingModel: true },
  ] as const)('submits the first regenerated-branch draft with $permissions and pending model $pendingModel', async ({ permissions, pendingModel }) => {
    const api = createBranchingDesktopApi(permissions)
    const regenerate = vi.mocked(api.localChat.chat.regenerateAssistant).getMockImplementation()!
    vi.mocked(api.localChat.chat.regenerateAssistant).mockImplementation(async (input) => {
      const result = await regenerate(input)
      return { ...result, run: { ...result.run, ...permissions, status: 'completed', completedAt: '2026-08-15T00:00:01.000Z' } }
    })
    const startTurn = vi.mocked<LexoraDesktopApi['localChat']['chat']['startTurn']>(api.localChat.chat.startTurn).getMockImplementation()!
    let submitted: LocalComposerDraft | null = null
    vi.mocked(api.localChat.chat.startTurn).mockImplementation(async (input) => {
      submitted = await api.localChat.composerDrafts.get(input.draftId)
      return startTurn(input)
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()

    expect(await chat.workspace.execution.regenerateAssistant('run-2')).toBe(true)
    expect(chat.workspace.session.activeBranchId.value).toBe('branch-regenerated')
    expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
    const modelSave = deferred<LocalConversation>()
    const modelSelection = { providerId: 'provider-1', modelId: 'model-2', reasoning: 'medium' as const, serviceTier: null }
    vi.mocked(api.localChat.conversations.setModelSelection).mockImplementation(() => modelSave.promise)
    const selecting = pendingModel ? chat.workspace.composer.selectModel('provider-1:model-2') : Promise.resolve()
    const content = { ...createBuddyUserContent(), body: [{ type: 'paragraph' as const, content: [{ type: 'prompt_directive' as const, commandMode: 'prompt' as const, directive: 'slash_command' as const, value: '/review' }, { type: 'text' as const, text: ' inspect the current task' }] }] }
    const sending = chat.workspace.execution.send({ content: '/review inspect the current task', userContent: content })
    if (pendingModel) {
      expect(await chat.flushDrafts()).toBe(true)
      expect((await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)).executionConfig).toEqual(permissions)
      modelSave.resolve({ ...chat.session.activeTask.value!, modelSelection })
    }
    await selecting
    expect(await sending).toBe(true)
    expect(submitted).toMatchObject({
      content,
      executionConfig: permissions,
      modelSelection: pendingModel ? modelSelection : null,
      scope: { kind: 'conversation_branch', conversationId: 'conversation-1', branchId: 'branch-regenerated' },
    })
    expect(chat.workspace.composer.draft.value).toBe('')
    expect(chat.workspace.status.errorMessage.value).toBeNull()
    chat.dispose()
  })

  it('does not start a turn while permission settings are being committed', async () => {
    const api = createBranchingDesktopApi()
    const pendingPermissionSettings = deferred<Awaited<ReturnType<
      typeof api.localChat.conversations.setPermissionSettings
    >>>()
    const setPermissionSettings = vi.mocked(api.localChat.conversations.setPermissionSettings)
    setPermissionSettings.mockImplementation(() => pendingPermissionSettings.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    const pendingDraftSave = deferred<void>()
    const saveDraft = api.localChat.composerDrafts.save
    api.localChat.composerDrafts.save = vi.fn(async (input) => {
      await pendingDraftSave.promise
      return saveDraft(input)
    })

    const updating = chat.workspace.composer.setPermissionMode('full_access')
    await vi.waitUntil(() => setPermissionSettings.mock.calls.length === 1)
    expect(chat.workspace.execution.canSend.value).toBe(false)
    await expect(chat.workspace.execution.send('must wait')).resolves.toBe(false)

    pendingPermissionSettings.resolve({ ...chat.session.activeTask.value!, executionProfile: 'full_access' })
    await vi.waitUntil(() => vi.mocked(api.localChat.composerDrafts.save).mock.calls.length > 0)
    expect(chat.workspace.execution.canSend.value).toBe(false)
    await expect(chat.workspace.execution.send('must wait for Draft')).resolves.toBe(false)
    pendingDraftSave.resolve()
    await expect(updating).resolves.toBe(true)
    expect(chat.workspace.execution.canSend.value).toBe(true)
    const draft = await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)
    expect(draft.executionConfig).toEqual({ approvalPolicy: 'policy', executionProfile: 'full_access' })
  })

  it('routes compact input through the command lifecycle without creating a turn', async () => {
    const api = createBranchingDesktopApi()
    const compactRun = {
      ...queuedRun(),
      branchId: 'branch-root',
      id: 'run-compact',
      purpose: 'conversation.compaction',
      triggeringMessageId: 'user-2',
    }
    vi.mocked(api.localChat.chat.executeCommand).mockImplementation(async input => ({
      branchId: 'branch-root',
      conversationId: 'conversation-1',
      draftReceipt: {
        committedRevision: input.expectedRevision + 1,
        draftId: input.draftId,
        sourceRevision: input.expectedRevision,
      },
      userMessage: null,
      run: compactRun,
      runId: compactRun.id,
    }))
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('/compact focus on decisions', null)

    await expect(chat.workspace.execution.send('/compact focus on decisions')).resolves.toBe(true)

    expect((await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)).content).toMatchObject({
      body: [{ content: [
        { commandMode: 'action', directive: 'slash_command', value: '/compact' },
        { text: ' focus on decisions', type: 'text' },
      ] }],
    })
    expect(api.localChat.chat.startTurn).not.toHaveBeenCalled()
    expect(chat.workspace.execution.activeRun.value).toMatchObject({ id: 'run-compact' })
    expect(chat.workspace.execution.submissionRevision.value).toBe(1)
    expect(chat.workspace.composer.draft.value).toBe('')
  })

  it('clears the previous branch projection while an activated branch is loading', async () => {
    const api = createBranchingDesktopApi()
    vi.mocked(api.localChat.conversations.listBranches).mockResolvedValue([
      branch('branch-root', null, null, '2026-08-14T00:00:00.000Z'),
      branch('branch-fork', 'branch-root', 'assistant-1', '2026-08-15T00:00:00.000Z'),
    ])
    const pendingTimeline = deferred<Awaited<ReturnType<
      typeof api.localChat.conversations.listTimeline
    >>>()
    vi.mocked(api.localChat.conversations.listTimeline).mockImplementation(async ({ branchId }) => {
      if (branchId === 'branch-fork')
        return pendingTimeline.promise
      return { changeSets: [], items: branchTimeline('branch-root'), nextCursor: null, outputs: [], runEvents: [], runs: [] }
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()

    const activating = chat.workspace.transcript.activateBranch('branch-fork')
    await vi.waitUntil(() => vi.mocked(api.localChat.conversations.listTimeline).mock.calls.some(
      ([input]) => input.branchId === 'branch-fork',
    ))
    expect(chat.workspace.session.activeBranchId.value).toBe('branch-fork')
    expect(chat.workspace.transcript.messages.value).toEqual([])
    pendingTimeline.resolve({ changeSets: [], items: branchTimeline('branch-fork'), nextCursor: null, outputs: [], runEvents: [], runs: [] })
    await expect(activating).resolves.toBe(true)

    expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
  })
})

function createTestTask(api: ReturnType<typeof createDesktopApi>, initialTarget?: UseTaskCapabilityOptions['initialTarget']) {
  const appState = useDesktopAppState({ api })
  const chat = createTaskCapability(api, appState, initialTarget)

  return {
    ...chat,
    async initialize() {
      await appState.initialize()
      await appState.refreshRuntimeDependentState(new ServiceHost())
      await chat.initialize()
    },
  }
}

function createTaskCapability(
  api: ReturnType<typeof createDesktopApi>,
  appState: ReturnType<typeof useDesktopAppState>,
  initialTarget: UseTaskCapabilityOptions['initialTarget'] = { conversationId: null, branchId: null, spaceId: null },
) {
  const index = useTaskIndex({ api: api.localChat, applicationSettings: appState.stores.applicationSettings, ready: computed(() => appState.stores.runtimeSupervisor.runtimeState.value.status === 'ready') })
  return useTaskCapability({
    api,
    index,
    initialTarget,
    applicationSettings: appState.stores.applicationSettings,
    modelProviders: appState.stores.modelProviders,
    runtimeSupervisor: appState.stores.runtimeSupervisor,
  })
}

function createBranchingDesktopApi(permissions: Pick<LocalConversation, 'approvalPolicy' | 'executionProfile'> = { approvalPolicy: 'policy', executionProfile: 'workspace_write' }) {
  const api = createDesktopApi()
  let activeBranchId = 'branch-root'
  const conversation = () => ({
    buddyId: 'default',
    activeBranchId,
    activity: 'idle' as const,
    automationOccurrence: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    deletedAt: null,
    ...permissions,
    id: 'conversation-1',
    modelSelection: null,
    spaceId: null,
    title: 'Conversation 1',
    updatedAt: '2026-08-14T00:00:00.000Z',
  })
  const branches = [branch('branch-root', null, null, '2026-08-14T00:00:00.000Z')]
  vi.mocked(api.localChat.conversations.list).mockReset().mockImplementation(async () => [conversation()])
  vi.mocked(api.localChat.conversations.listTimeline).mockImplementation(async ({ branchId }) => (
    { changeSets: [], items: branchTimeline(branchId ?? activeBranchId), nextCursor: null, outputs: [], runEvents: [], runs: [] }
  ))
  vi.mocked(api.localChat.runs.list).mockResolvedValue([])
  api.localChat.conversations.listBranches = vi.fn(async () => branches)
  api.localChat.conversations.activateBranch = vi.fn(async ({ branchId }) => {
    activeBranchId = branchId
    return conversation()
  })
  api.localChat.chat.editUserMessage = vi.fn(async (input) => {
    activeBranchId = 'branch-edited'
    branches.push(branch(
      'branch-edited',
      'branch-root',
      'assistant-1',
      '2026-08-15T00:00:00.000Z',
    ))
    const editedRun = {
      ...queuedRun(),
      branchId: 'branch-edited',
      id: 'run-edited',
      triggeringMessageId: 'user-2-edited',
    }
    return {
      branchId: 'branch-edited',
      conversationId: 'conversation-1',
      draftReceipt: {
        committedRevision: input.expectedRevision + 1,
        draftId: input.draftId,
        sourceRevision: input.expectedRevision,
      },
      userMessage: null,
      run: editedRun,
      runId: editedRun.id,
    }
  })
  api.localChat.chat.regenerateAssistant = vi.fn(async () => {
    activeBranchId = 'branch-regenerated'
    branches.push(branch(
      'branch-regenerated',
      'branch-root',
      'user-2',
      '2026-08-15T00:00:00.000Z',
    ))
    const regeneratedRun = {
      ...queuedRun(),
      branchId: 'branch-regenerated',
      id: 'run-regenerated',
      triggeringMessageId: 'user-2',
    }
    return {
      branchId: 'branch-regenerated',
      conversationId: 'conversation-1',
      draftReceipt: null,
      userMessage: null,
      run: regeneratedRun,
      runId: regeneratedRun.id,
    }
  })
  return api
}

function conversationSummary(activity: 'idle' | 'running' | 'awaiting_approval') {
  return {
    buddyId: 'default',
    activeBranchId: 'branch-background',
    activity,
    automationOccurrence: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    deletedAt: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    id: 'conversation-background',
    modelSelection: null,
    spaceId: null,
    title: 'Background conversation',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}

function inputAttachment(id: string) {
  return {
    attachmentId: id,
    kind: 'image' as const,
    mimeType: 'image/png',
    name: `${id}.png`,
    previewUrl: null,
    sizeBytes: 8,
  }
}

function branch(
  id: string,
  parentBranchId: string | null,
  forkedFromMessageId: string | null,
  createdAt: string,
) {
  return {
    conversationId: 'conversation-1',
    createdAt,
    forkedFromMessageId,
    id,
    parentBranchId,
  }
}

function branchMessages(branchId: string) {
  const all = [
    message('user-1', 'user', 'branch-root'),
    message('assistant-1', 'assistant', 'branch-root'),
    message('user-2', 'user', 'branch-root'),
    message('assistant-2', 'assistant', 'branch-root'),
  ]
  return branchId === 'branch-root' ? all : all.slice(0, 2)
}

function branchTimeline(branchId: string) {
  return branchMessages(branchId).map(item => ({ ...item, kind: 'message' as const }))
}

function message(id: string, role: 'assistant' | 'user', branchId: string) {
  return {
    attachments: [],
    branchId,
    content: { text: id },
    conversationId: 'conversation-1',
    createdAt: '2026-08-14T00:00:00.000Z',
    id,
    role,
    runId: role === 'assistant' ? `run-${id}` : null,
  }
}

function queuedRun() {
  return {
    buddyId: 'default',
    branchId: 'branch-1',
    completedAt: null,
    conversationId: 'conversation-1',
    errorCode: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    id: 'run-1',
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-08-14T00:00:00.000Z',
    status: 'queued' as const,
    triggeringMessageId: 'message-1',
  }
}

function createDesktopApi() {
  const run = queuedRun()
  const draftsById = new Map<string, LocalComposerDraft>()
  const draftsByScope = new Map<string, LocalComposerDraft>()
  const conversationsList = vi.fn()
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error('collection refresh failed'))
  return {
    storage: { onProgress: () => () => {} },
    sync: { onChanged: () => () => {} },
    app: {
      getInfo: vi.fn(),
      updates: { onChanged: () => () => {}, getState: async () => ({ revision: 0, enabled: true, checking: false, lastCheckedAt: null, ignoredVersion: null, result: null, notification: null, reminderDueAt: null }) },
    },
    lifecycle: { quit: vi.fn() },
    localChat: {
      questions: { list: async () => [], onChanged: () => () => {} },
      executions: { list: async () => [], onChanged: () => () => {} },
      buddies: { list: vi.fn(async () => ({ revision: 1, defaultBuddyId: 'default', buddies: [] })) },
      taskMarks: { list: async () => [], states: async () => [] },
      composerDrafts: {
        get: vi.fn(async (draftId: string) => {
          const draft = draftsById.get(draftId)
          if (!draft)
            throw new Error('Draft not found')
          return structuredClone(draft)
        }),
        open: vi.fn(async (input) => {
          const key = JSON.stringify(input.scope)
          const existing = draftsByScope.get(key)
          if (existing)
            return structuredClone(existing)
          const draft: LocalComposerDraft = {
            content: structuredClone(input.initialContent),
            draftId: input.draftId,
            executionConfig: structuredClone(input.initialExecutionConfig),
            modelSelection: structuredClone(input.initialModelSelection),
            revision: 0,
            scope: structuredClone(input.scope),
            updatedAt: '2026-09-06T00:00:00.000Z',
          }
          draftsById.set(draft.draftId, draft)
          draftsByScope.set(key, draft)
          return structuredClone(draft)
        }),
        save: vi.fn(async (input) => {
          const current = draftsById.get(input.draftId)
          if (!current || current.revision !== input.expectedRevision)
            throw new Error('Draft conflict')
          const draft: LocalComposerDraft = {
            ...current,
            content: structuredClone(input.content),
            executionConfig: structuredClone(input.executionConfig),
            modelSelection: structuredClone(input.modelSelection),
            revision: current.revision + 1,
            updatedAt: '2026-09-06T00:00:01.000Z',
          }
          draftsById.set(draft.draftId, draft)
          draftsByScope.set(JSON.stringify(draft.scope), draft)
          return structuredClone(draft)
        }),
      },
      composerResources: {
        onChanged: () => () => {},
        accept: vi.fn(async (input: BuddyComposerResourceAccept) => input.resources.map(resource => ({ ...resource, draftId: input.draftId, kind: 'image', state: 'importing' }))),
        complete: vi.fn(),
        fail: vi.fn(),
        list: vi.fn<LexoraDesktopApi['localChat']['composerResources']['list']>(async () => []),
        listSources: vi.fn(async () => ({ files: [] })),
        retry: vi.fn(),
        selectFiles: vi.fn(async () => []),
        selectSource: vi.fn(),
      },
      artifacts: {
        onChanged: vi.fn(() => () => {}),
        readText: vi.fn(),
      },
      automations: {
        onChanged: vi.fn(() => () => {}),
      },
      approvals: {
        approve: vi.fn(),
        deny: vi.fn(),
        list: vi.fn(async () => []),
      },
      chat: {
        cancel: vi.fn(),
        editUserMessage: vi.fn(),
        executeCommand: vi.fn(),
        onRunEvent: vi.fn(() => () => {}),
        regenerateAssistant: vi.fn(),
        startTurn: vi.fn(async (input: LocalStartTurnRequest) => {
          const draft = draftsById.get(input.draftId)
          if (!draft || draft.revision !== input.expectedRevision)
            throw new Error('Draft conflict')
          const committed: LocalComposerDraft = {
            ...draft,
            content: createBuddyUserContent(),
            revision: draft.revision + 1,
            scope: {
              branchId: 'branch-1',
              conversationId: 'conversation-1',
              kind: 'conversation_branch',
            },
            updatedAt: '2026-09-06T00:00:02.000Z',
          }
          draftsById.set(committed.draftId, committed)
          draftsByScope.delete(JSON.stringify(draft.scope))
          draftsByScope.set(JSON.stringify(committed.scope), committed)
          return {
            branchId: 'branch-1',
            conversationId: 'conversation-1',
            draftReceipt: {
              committedRevision: committed.revision,
              draftId: committed.draftId,
              sourceRevision: draft.revision,
            },
            run,
            runId: 'run-1',
          }
        }),
      },
      changes: {
        onChanged: vi.fn(() => () => {}),
        get: vi.fn(),
      },
      connectors: { list: vi.fn(async () => []) },
      context: {
        getUsageSnapshot: vi.fn(async () => ({
          contextWindow: 4096,
          createdAt: '2026-08-19T00:00:00.000Z',
          mcpTokens: 0,
          messageTokens: 0,
          modelId: 'model-1',
          providerId: 'provider-1',
          skillTokens: 0,
          systemPromptTokens: 20,
          toolTokens: 30,
          totalTokens: 50,
        })),
      },
      notifications: {
        onChanged: () => () => {},
        list: vi.fn(async () => ({ items: [], unseenCount: 0 })),
        markAllSeen: vi.fn(async () => ({ items: [], unseenCount: 0 })),
        markSeen: vi.fn(async () => ({ items: [], unseenCount: 0 })),
      },
      conversations: {
        onTimelineChanged: vi.fn(() => () => {}),
        onChanged: vi.fn(() => () => {}),
        activateBranch: vi.fn(),
        delete: vi.fn(),
        list: conversationsList,
        listBranches: vi.fn(async () => []),
        listMessages: vi.fn(async () => ({ items: [], nextCursor: null })),
        listTimeline: vi.fn(async () => ({ changeSets: [], items: [], nextCursor: null, outputs: [], runEvents: [], runs: [] })),
        setPermissionSettings: vi.fn(),
        setModelSelection: vi.fn(),
        getModelControls: vi.fn(async () => ({ current: null, next: { actorId: 'default', isMember: true, modelSelection: null } })),
      },
      spaces: {
        onChanged: () => () => {},
        create: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => []),
        searchFiles: vi.fn(async () => []),
        selectDirectory: vi.fn(async () => null),
        update: vi.fn(),
      },
      providers: {
        onChanged: () => () => {},
        listBuiltinPresets: vi.fn(async () => []),
        getDefaultModel: vi.fn(async () => ({ modelId: 'model-1', providerId: 'provider-1' })),
        list: vi.fn(async () => [{
          activeRunCount: 0,
          added: true,
          api: null,
          authTypes: ['api_key'],
          baseUrl: null,
          canSyncModels: true,
          custom: false,
          displayName: 'Provider',
          enabled: true,
          enabledModelCount: 1,
          id: 'provider-1',
          modelCount: 1,
          setupComplete: true,
          status: 'available',
          storedCredentialType: 'api_key',
          syncUnavailableReason: null,
        }]),
        listModels: vi.fn(async () => [{
          available: true,
          catalogMatch: 'not_applicable',
          catalog: { source: null, selection: null, candidates: [] },
          metadataKnown: true,
          capabilityOverrides: null,
          fileInputMimeTypes: [],
          sourceCapabilities: { image: false, reasoningOptions: ['off', 'low', 'medium', 'high'] },
          api: 'openai-completions',
          capabilities: ['text'],
          contextWindow: 4096,
          displayName: 'Model',
          enabled: true,
          hasParameterOverride: false,
          lastSeenAt: '2026-08-19T00:00:00.000Z',
          maxTokens: 1024,
          modelId: 'model-1',
          overrideContextWindow: null,
          overrideMaxTokens: null,
          providerId: 'provider-1',
          reasoningOptions: ['off', 'low', 'medium', 'high'],
          serviceTiers: [],
          source: 'builtin',
          sourceContextWindow: 4096,
          sourceMaxTokens: 1024,
          sourceParametersUpdated: false,
        }, {
          available: true,
          catalogMatch: 'not_applicable',
          catalog: { source: null, selection: null, candidates: [] },
          metadataKnown: true,
          capabilityOverrides: null,
          fileInputMimeTypes: [],
          sourceCapabilities: { image: false, reasoningOptions: ['off', 'low', 'medium', 'high'] },
          api: 'openai-completions',
          capabilities: ['text', 'reasoning'],
          contextWindow: 4096,
          displayName: 'Model 2',
          enabled: true,
          hasParameterOverride: false,
          lastSeenAt: '2026-08-19T00:00:00.000Z',
          maxTokens: 1024,
          modelId: 'model-2',
          overrideContextWindow: null,
          overrideMaxTokens: null,
          providerId: 'provider-1',
          reasoningOptions: ['off', 'low', 'medium', 'high'],
          serviceTiers: [],
          source: 'builtin',
          sourceContextWindow: 4096,
          sourceMaxTokens: 1024,
          sourceParametersUpdated: false,
        }]),
        onAuthChallenge: vi.fn(() => () => {}),
        setDefaultModel: vi.fn(async value => value),
      },
      runs: {
        get: vi.fn(async () => run),
        list: vi.fn(async () => [run]),
        listEvents: vi.fn(async () => []),
      },
      runtime: {
        getStatus: vi.fn(async () => ({
          lastError: null,
          pid: 1,
          restartAttempt: 0,
          status: 'ready',
        })),
        onStateChanged: vi.fn(() => () => {}),
      },
      skills: { list: vi.fn(async () => ({ diagnostics: [], skills: [] })) },
      usage: { getSnapshot: vi.fn() },
      workspaceState: {
        read: vi.fn(async () => null),
        write: vi.fn(async value => ({
          key: 'buddy.chat.workspace.v2',
          updatedAt: '2026-08-14T00:00:00.000Z',
          value,
        })),
      },
    },
    settings: {
      get: vi.fn(async () => Promise.reject(new Error('settings unavailable'))),
      update: vi.fn(),
    },
    window: {},
  } as unknown as LexoraDesktopApi & {
    localChat: LexoraDesktopApi['localChat'] & {
      chat: LexoraDesktopApi['localChat']['chat'] & { startTurn: ReturnType<typeof vi.fn> }
    }
  }
}
