import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyUserMessageContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalStartTurnRequest } from '@buddy-shared/conversation/chatApi'
import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'
import type { BuddyComposerResourceAccept } from '@buddy-shared/conversation/composerResource'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'

import type { UseTaskCapabilityOptions } from '../useTaskCapability'
import { ServiceHost } from '@buddy-shared/lifecycle/ServiceHost'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { createBuddyUserContent } from '../../../../../shared/conversation/buddyUserContent'

import { useDesktopAppState } from '../../../../app/bootstrap/useDesktopAppState'
import { useTaskIndex } from '../task-index/useTaskIndex'
import { useTaskCapability } from '../useTaskCapability'

describe('useTaskCapability', () => {
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
    chat.cancelClose()
    chat.workspace.composer.updateComposerContent('Input after cancellation', null)
    expect(chat.workspace.status.isClosing.value).toBe(false)
    expect(await chat.flushDrafts()).toBe(true)
    expect((await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)).content).toEqual(createBuddyUserContent('Input after cancellation'))
    chat.dispose()
  })

  it('initializes a confirmed model-less Draft when the first model becomes available', async () => {
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
    expect((await api.localChat.composerDrafts.get(draftId)).modelSelection).toEqual({
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: 'medium',
      serviceTier: null,
    })
    chat.workspace.composer.updateComposerContent('first configured task', null)
    expect(await chat.workspace.execution.send('first configured task')).toBe(true)
  })

  it('restores the saved Draft model into the composer and submits that same configuration', async () => {
    const api = createDesktopApi()
    const models = await api.localChat.providers.listModels()
    vi.mocked(api.localChat.providers.listModels).mockResolvedValue(models.map(model => ({
      ...model,
      serviceTiers: [{ displayName: 'Fast', id: 'priority' }],
    })))
    const savedModel = {
      modelId: 'model-2',
      providerId: 'provider-1',
      reasoning: 'high' as const,
      serviceTier: 'priority' as const,
    }
    const remote = await api.localChat.composerDrafts.open({
      draftId: 'saved-global-draft',
      initialContent: createBuddyUserContent('saved input'),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: savedModel,
      scope: { kind: 'global' },
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()

    expect(chat.workspace.composer.selectedModelId.value).toBe('provider-1:model-2')
    expect(chat.workspace.composer.selectedEffort.value).toBe('high')
    expect(chat.workspace.composer.selectedServiceTier.value).toBe('priority')
    expect(chat.workspace.composer.draft.value).toBe('saved input')
    expect(await chat.workspace.execution.send('saved input')).toBe(true)
    const sent = vi.mocked(api.localChat.chat.startTurn).mock.calls[0]![0]
    expect(sent.draftId).toBe(remote.draftId)
    expect((await api.localChat.composerDrafts.get(sent.draftId)).modelSelection).toEqual(savedModel)
    expect(api.localChat.providers.setDefaultModel).not.toHaveBeenCalled()
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
    expect(first).toBe(second)
    await first

    expect(chat.workspace.composer.draftId.value).toBe(draftId)
    expect(chat.workspace.composer.draft.value).toBe('typed after Runtime failure')
    expect(await chat.flushDrafts()).toBe(true)
    expect(await chat.workspace.execution.send('typed after Runtime failure')).toBe(true)
  })

  it('commits an accepted turn before collection refresh failures', async () => {
    const api = createDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('hello', null)
    const sourceDraftId = chat.workspace.composer.draftId.value

    await expect(chat.workspace.execution.send('hello')).resolves.toBe(true)
    expect(chat.session.activeTaskId.value).toBe('conversation-1')
    expect(chat.workspace.execution.activeRun.value?.id).toBe('run-1')
    expect(chat.workspace.composer.draft.value).toBe('')
    expect(chat.workspace.composer.draftId.value).toBe(sourceDraftId)
    expect(api.localChat.chat.startTurn).toHaveBeenCalledOnce()
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

    const selecting = chat.workspace.composer.selectAttachments()
    await vi.waitUntil(() => chat.workspace.composer.isSelectingFiles.value)
    await chat.session.openTask('conversation-background')
    chat.workspace.composer.updateComposerContent('destination draft', null)
    const attachment = {
      ...inputAttachment('selected-image'),
      draftId: chat.workspace.composer.draftId.value,
      kind: 'image' as const,
      resourceId: 'resource-selected',
      state: 'ready' as const,
    }
    const sourceDraftId = vi.mocked(api.localChat.composerResources.selectFiles).mock.calls[0]![0]
    attachment.draftId = sourceDraftId
    selected.resolve([attachment])
    await selecting

    expect(chat.workspace.composer.draft.value).toBe('destination draft')
    await chat.session.startTask(null)
    expect(chat.workspace.composer.draft.value).toBe('source draft')
    expect(chat.workspace.composer.resources.value.map(entry => entry.resource)).toEqual([attachment])
    expect(chat.workspace.composer.composerContent.value).toMatchObject({ attrs: { panelResourceIds: ['resource-selected'] } })
  })

  it('does not let a slow conversation model response overwrite the latest selection', async () => {
    const api = createDesktopApi()
    const conversation = {
      activeBranchId: 'branch-1',
      activity: 'idle' as const,
      automationOccurrence: null,
      createdAt: '2026-08-14T00:00:00.000Z',
      deletedAt: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'conversation-1',
      modelSelection: {
        modelId: 'model-1',
        providerId: 'provider-1',
        reasoning: null,
        serviceTier: null,
      },
      spaceId: null,
      title: 'Conversation 1',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }
    vi.mocked(api.localChat.conversations.list).mockReset().mockResolvedValue([conversation])
    const first = deferred<LocalConversation>()
    const second = deferred<LocalConversation>()
    let callCount = 0
    vi.mocked(api.localChat.conversations.setModelSelection).mockImplementation(() => {
      callCount += 1
      return callCount === 1 ? first.promise : second.promise
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    await chat.session.openTask('conversation-1')

    const firstSelection = chat.workspace.composer.selectModel('provider-1:model-2')
    await vi.waitUntil(() => callCount === 1)
    const secondSelection = chat.workspace.composer.selectModel('provider-1:model-1')
    first.resolve({ ...conversation, modelSelection: { modelId: 'model-2', providerId: 'provider-1', reasoning: 'medium', serviceTier: null } })
    await vi.waitUntil(() => callCount === 2)
    second.resolve(conversation)

    await Promise.all([firstSelection, secondSelection])
    expect(chat.workspace.composer.selectedModelId.value).toBe('provider-1:model-1')
    expect(chat.workspace.session.activeConversation.value?.modelSelection?.modelId).toBe('model-1')
    expect(api.localChat.providers.setDefaultModel).toHaveBeenLastCalledWith({
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: 'medium',
    })
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
        branchId: 'branch-1',
        completedAt: '2026-08-17T00:00:01.000Z',
        conversationId: 'conversation-1',
        errorCode: 'SESSION_STORAGE_UNAVAILABLE',
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        id: 'run-session-storage-failed',
        modelId: 'model-1',
        providerId: 'provider-1',
        purpose: 'chat',
        reasoningLevel: null,
        startedAt: '2026-08-17T00:00:00.000Z',
        status: 'failed',
        triggeringMessageId: 'message-1',
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

  it('submits the latest Draft when edits arrive during save confirmation', async () => {
    const api = createDesktopApi()
    const saving = deferred<void>()
    const saved: string[] = []
    const saveDraft = vi.mocked(api.localChat.composerDrafts.save).getMockImplementation()!
    vi.mocked(api.localChat.composerDrafts.save).mockImplementation(async (value) => {
      await saving.promise
      saved.push(value.content.body[0]?.content.map(node => node.type === 'text' ? node.text : '').join('') ?? '')
      return saveDraft(value)
    })
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('before save', null)

    const sending = chat.workspace.execution.send('before save')
    await vi.waitUntil(() => vi.mocked(api.localChat.composerDrafts.save).mock.calls.length > 0)
    chat.workspace.composer.updateComposerContent('newer edit', null)
    saving.resolve()

    await expect(sending).resolves.toBe(true)
    expect(api.localChat.chat.startTurn).toHaveBeenCalledOnce()
    expect(chat.workspace.composer.draft.value).toBe('')
    expect(saved.at(-1)).toBe('newer edit')
  })

  it('preserves newer edits when a previous send returns to the same draft', async () => {
    const api = createDesktopApi()
    const accepted = {
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      draftReceipt: {
        committedRevision: 2,
        draftId: 'draft-runtime',
        sourceRevision: 1,
      },
      run: queuedRun(),
      runId: 'run-1',
    }
    const sendingGate = deferred<typeof accepted>()
    vi.mocked(api.localChat.chat.startTurn).mockImplementation(() => sendingGate.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('sent input', null)
    const sourceDraftId = chat.workspace.composer.draftId.value

    const sending = chat.workspace.execution.send('sent input')
    await vi.waitUntil(() => vi.mocked(api.localChat.chat.startTurn).mock.calls.length === 1)
    chat.workspace.composer.updateComposerContent('newer unsent input', null)
    sendingGate.resolve(accepted)

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

  it('does not let a completed send take over a conversation opened while it was pending', async () => {
    const api = createDesktopApi()
    const pendingTurn = deferred<Awaited<ReturnType<typeof api.localChat.chat.startTurn>>>()
    const conversationB = {
      activeBranchId: 'branch-b',
      activity: 'idle' as const,
      automationOccurrence: null,
      createdAt: '2026-08-14T00:00:00.000Z',
      deletedAt: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'conversation-b',
      modelSelection: null,
      spaceId: 'space-b',
      title: 'Conversation B',
      updatedAt: '2026-08-14T00:00:00.000Z',
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
    pendingTurn.resolve({
      branchId: 'branch-a',
      conversationId: 'conversation-a',
      draftReceipt: {
        committedRevision: request.expectedRevision + 1,
        draftId: request.draftId,
        sourceRevision: request.expectedRevision,
      },
      run: {
        branchId: 'branch-a',
        completedAt: null,
        conversationId: 'conversation-a',
        errorCode: null,
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        id: 'run-a',
        modelId: 'model-1',
        providerId: 'provider-1',
        purpose: 'chat',
        reasoningLevel: null,
        startedAt: '2026-08-14T00:00:00.000Z',
        status: 'queued',
        triggeringMessageId: 'message-a',
      },
      runId: 'run-a',
    })

    await expect(sending).resolves.toBe(true)
    expect(chat.session.activeTaskId.value).toBe('conversation-b')
    expect(chat.session.spaceId.value).toBe('space-b')
  })

  it('does not surface a stale send failure in a conversation opened while it was pending', async () => {
    const api = createDesktopApi()
    const pendingTurn = deferred<Awaited<ReturnType<typeof api.localChat.chat.startTurn>>>()
    const conversationB = {
      activeBranchId: 'branch-b',
      activity: 'idle' as const,
      automationOccurrence: null,
      createdAt: '2026-08-14T00:00:00.000Z',
      deletedAt: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'conversation-b',
      modelSelection: null,
      spaceId: null,
      title: 'Conversation B',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }
    vi.mocked(api.localChat.conversations.list).mockReset().mockResolvedValue([conversationB])
    api.localChat.chat.startTurn.mockImplementation(() => pendingTurn.promise)
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api)
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('hello from A', null)

    const sending = chat.workspace.execution.send('hello from A')
    await vi.waitUntil(() => api.localChat.chat.startTurn.mock.calls.length === 1)
    await chat.session.openTask('conversation-b')
    pendingTurn.reject(new Error('conversation A failed'))

    await expect(sending).resolves.toBe(false)
    expect(chat.session.activeTaskId.value).toBe('conversation-b')
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

    await expect(chat.workspace.execution.submitEditedMessage({
      content: 'edited follow-up',
      userContent: createBuddyUserContent('edited follow-up'),
    })).resolves.toBe(true)

    expect(api.localChat.chat.editUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      expectedRevision: expect.any(Number),
      userMessageId: 'user-2',
    }))
    expect(chat.workspace.session.activeBranchId.value).toBe('branch-edited')
    expect(chat.workspace.transcript.branches.value.map(branch => branch.id)).toEqual(['branch-root', 'branch-edited'])
    expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
  })

  it('commits an edited Draft only once when submit is triggered twice', async () => {
    const api = createBranchingDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    await expect(chat.workspace.execution.editUserMessage('user-2')).resolves.toBe(true)
    const payload = {
      content: 'edited follow-up',
      userContent: createBuddyUserContent('edited follow-up'),
    }

    const firstSubmission = chat.workspace.execution.submitEditedMessage(payload)
    const secondSubmission = chat.workspace.execution.submitEditedMessage(payload)

    await expect(secondSubmission).resolves.toBe(false)
    await expect(firstSubmission).resolves.toBe(true)
    expect(api.localChat.chat.editUserMessage).toHaveBeenCalledTimes(1)
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
    expect(sourceContent.userContent.body[0]?.content[1]).toEqual({ resourceId: 'source-resource', type: 'resource_ref' })
  })

  it('commits a regenerated run on its new branch before background refreshes', async () => {
    const api = createBranchingDesktopApi()
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()

    await expect(chat.workspace.execution.regenerateAssistant('run-2')).resolves.toBe(true)

    expect(api.localChat.chat.regenerateAssistant).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      sourceRunId: 'run-2',
    }))
    expect(chat.workspace.session.activeBranchId.value).toBe('branch-regenerated')
    expect(chat.workspace.execution.activeRun.value?.id).toBe('run-regenerated')
    expect(chat.workspace.transcript.messages.value.map(message => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
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

    pendingPermissionSettings.resolve({
      activeBranchId: 'branch-root',
      createdAt: '2026-08-14T00:00:00.000Z',
      deletedAt: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'full_access',
      id: 'conversation-1',
      modelSelection: null,
      spaceId: null,
      title: 'Conversation 1',
      updatedAt: '2026-08-14T00:01:00.000Z',
    })
    await vi.waitUntil(() => vi.mocked(api.localChat.composerDrafts.save).mock.calls.length > 0)
    expect(chat.workspace.execution.canSend.value).toBe(false)
    await expect(chat.workspace.execution.send('must wait for Draft')).resolves.toBe(false)
    pendingDraftSave.resolve()
    await expect(updating).resolves.toBe(true)
    expect(chat.workspace.execution.canSend.value).toBe(true)
    const draft = await api.localChat.composerDrafts.get(chat.workspace.composer.draftId.value)
    expect(draft.executionConfig).toEqual({ approvalPolicy: 'policy', executionProfile: 'full_access' })
  })

  it.each(['text', 'structured'])('routes %s compact input through the command lifecycle without creating a turn', async (inputKind) => {
    const api = createBranchingDesktopApi()
    const compactRun = {
      branchId: 'branch-root',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'run-compact',
      modelId: 'model-1',
      providerId: 'provider-1',
      purpose: 'conversation.compaction',
      reasoningLevel: null,
      startedAt: '2026-08-15T00:00:00.000Z',
      status: 'queued' as const,
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
      run: compactRun,
      runId: compactRun.id,
    }))
    vi.stubGlobal('window', Object.assign(globalThis, { lexoraDesktop: api }))
    const chat = createTestTask(api, { conversationId: 'conversation-1', branchId: 'branch-root', spaceId: null })
    await chat.initialize()
    chat.workspace.composer.updateComposerContent('/compact focus on decisions', null)

    const payload = inputKind === 'structured'
      ? {
          content: '/compact focus on decisions',
          userContent: { version: 1 as const, panelResourceIds: [], body: [{ type: 'paragraph' as const, content: [
            { type: 'prompt_directive' as const, directive: 'slash_command' as const, commandMode: 'action' as const, value: '/compact' },
            { type: 'text' as const, text: ' focus on decisions' },
          ] }] },
        }
      : '/compact focus on decisions'
    await expect(chat.workspace.execution.send(payload)).resolves.toBe(true)

    expect(api.localChat.chat.executeCommand).toHaveBeenCalledWith({
      draftId: expect.any(String),
      expectedRevision: expect.any(Number),
      requestId: expect.any(String),
    })
    expect(vi.mocked(api.localChat.composerDrafts.save).mock.calls.at(-1)?.[0].content).toMatchObject({
      body: [{ content: [
        { commandMode: 'action', directive: 'slash_command', value: '/compact' },
        { text: ' focus on decisions', type: 'text' },
      ] }],
    })
    expect(api.localChat.chat.startTurn).not.toHaveBeenCalled()
    expect(chat.workspace.execution.activeRun.value).toMatchObject({ id: 'run-compact' })
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

function createBranchingDesktopApi() {
  const api = createDesktopApi()
  let activeBranchId = 'branch-root'
  const conversation = () => ({
    activeBranchId,
    activity: 'idle' as const,
    automationOccurrence: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    deletedAt: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
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
      branchId: 'branch-edited',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'run-edited',
      modelId: 'model-1',
      providerId: 'provider-1',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-08-15T00:00:00.000Z',
      status: 'queued' as const,
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
      branchId: 'branch-regenerated',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'run-regenerated',
      modelId: 'model-1',
      providerId: 'provider-1',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-08-15T00:00:00.000Z',
      status: 'queued' as const,
      triggeringMessageId: 'user-2',
    }
    return {
      branchId: 'branch-regenerated',
      conversationId: 'conversation-1',
      draftReceipt: null,
      run: regeneratedRun,
      runId: regeneratedRun.id,
    }
  })
  return api
}

function conversationSummary(activity: 'idle' | 'running' | 'awaiting_approval') {
  return {
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
    app: { getInfo: vi.fn() },
    lifecycle: { quit: vi.fn() },
    localChat: {
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
        list: vi.fn(async () => ({ items: [], unseenCount: 0 })),
        markAllSeen: vi.fn(async () => ({ items: [], unseenCount: 0 })),
        markSeen: vi.fn(async () => ({ items: [], unseenCount: 0 })),
      },
      conversations: {
        activateBranch: vi.fn(),
        delete: vi.fn(),
        list: conversationsList,
        listBranches: vi.fn(async () => []),
        listMessages: vi.fn(async () => ({ items: [], nextCursor: null })),
        listTimeline: vi.fn(async () => ({ changeSets: [], items: [], nextCursor: null, outputs: [], runEvents: [], runs: [] })),
        setPermissionSettings: vi.fn(),
        setModelSelection: vi.fn(),
      },
      spaces: {
        create: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => []),
        searchFiles: vi.fn(async () => []),
        selectDirectory: vi.fn(async () => null),
        update: vi.fn(),
      },
      providers: {
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
