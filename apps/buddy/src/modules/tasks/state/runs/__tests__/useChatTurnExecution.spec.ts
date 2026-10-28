import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyInputDelivery } from '@buddy-shared/conversation/chatApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { ExecutionTarget, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import { browserQuote } from '@buddy-shared/browser/__tests__/browserSelectionFixture'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { formatLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, shallowRef } from 'vue'
import { useComposerTarget } from '../../composer/useComposerTarget'
import { useChatSession } from '../../conversations/useChatSession'
import { useChatDrafts } from '../../drafts/useChatDrafts'
import { useChatTurnExecution } from '../useChatTurnExecution'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

describe('useChatTurnExecution cancellation ownership', () => {
  it('retains cancellation feedback and queues input until cleanup finishes after the terminal event', async () => {
    const f = createFixture()
    f.selectedModel.value = { modelId: 'model-a', providerId: 'provider-a' } as LocalRuntimeModelOption
    const snapshot = f.drafts.snapshot('conversation:conversation-a:branch-a')
    f.drafts.confirmOpen(snapshot, {
      content: snapshot.content,
      draftId: snapshot.draftId,
      executionConfig: { approvalPolicy: snapshot.approvalPolicy, executionProfile: snapshot.executionProfile },
      modelSelection: null,
      revision: 1,
      scope: { kind: 'conversation_branch', conversationId: 'conversation-a', branchId: 'branch-a' },
      updatedAt: '2026-09-08T00:00:00.000Z',
    })
    f.api.chat.enqueue.mockResolvedValue({ id: 'queued-after-stop', conversationId: 'conversation-a', branchId: 'branch-a', draftReceipt: { draftId: snapshot.draftId, sourceRevision: 1, committedRevision: 2 } })
    const cancelling = f.execution.cancelActiveRun()
    const terminal = { ...f.run, status: 'cancelled' as const }
    f.projectedRuns.value = [terminal]
    expect(f.execution.stoppingRunId.value).toBe(f.run.id)
    expect(await f.execution.send('pending input')).toBe(true)
    expect(f.drafts.draft.value).toBe('')
    expect(f.api.chat.enqueue).toHaveBeenCalledOnce()
    expect(f.api.chat.startTurn).not.toHaveBeenCalled()
    f.drafts.updateComposerContent('next draft', null)
    f.pending.resolve(terminal)
    await cancelling
    expect(f.execution.stoppingRunId.value).toBeNull()
    expect(f.projectedRuns.value).toEqual([terminal])
    expect(f.drafts.draft.value).toBe('next draft')
    expect(f.api.chat.steerQueued).not.toHaveBeenCalled()
  })

  it('reports a cancellation failure only in the originating view', async () => {
    const fixture = createFixture()
    const cancelling = fixture.execution.cancelActiveRun()
    expect(fixture.execution.stoppingRunId.value).toBe(fixture.run.id)
    fixture.pending.reject(new Error('cancel failed'))
    await cancelling
    expect(fixture.execution.stoppingRunId.value).toBeNull()

    expect(fixture.error.value).toBeTruthy()
    expect(fixture.projectedRuns.value).toEqual([fixture.run])
    expect(fixture.drafts.draft.value).toBe('pending input')
  })

  it.each(['success', 'error'] as const)('ignores a late cancellation %s after its owner is disposed', async (outcome) => {
    const fixture = createFixture()
    const cancelling = fixture.execution.cancelActiveRun()
    fixture.scope.stop()
    fixture.error.value = 'retained status'
    if (outcome === 'success')
      fixture.pending.resolve({ ...fixture.run, status: 'cancelled' })
    else
      fixture.pending.reject(new Error('late cancellation failed'))
    await cancelling

    expect(fixture.projectedRuns.value).toEqual([fixture.run])
    expect(fixture.error.value).toBe('retained status')
    expect(fixture.drafts.draft.value).toBe('pending input')
  })

  it.each([
    { navigation: 'task', outcome: 'success' },
    { navigation: 'branch', outcome: 'error' },
    { navigation: 'return-to-task', outcome: 'error' },
    { navigation: 'return-to-branch', outcome: 'success' },
  ] as const)('ignores a late cancellation $outcome after navigating to $navigation', async ({ navigation, outcome }) => {
    const fixture = createFixture()
    const cancelling = fixture.execution.cancelActiveRun()
    fixture.navigate(navigation)
    expect(fixture.execution.stoppingRunId.value).toBe(navigation.startsWith('return-to-') ? fixture.run.id : null)
    if (outcome === 'success')
      fixture.pending.resolve({ ...fixture.run, status: 'cancelled' })
    else
      fixture.pending.reject(new Error('old cancellation failed'))
    await cancelling

    expect(fixture.projectedRuns.value).toEqual([])
    expect(fixture.drafts.draft.value).toBe('current view input')
    expect(fixture.error.value).toBe('current view status')
  })
})

describe('turn submission conflicts', () => {
  it('submits a reference-only draft without requiring a question or comment', async () => {
    const f = createFixture()
    f.projectedRuns.value = []
    f.selectedModel.value = { modelId: 'model-a', providerId: 'provider-a' } as LocalRuntimeModelOption
    const quote = { id: 'file-quote', text: 'frozen excerpt', source: { kind: 'file' as const, title: 'notes.md', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'notes.md' }, format: 'markdown' as const } }
    const content = { ...createBuddyUserContent(), resourceQuotes: [quote, browserQuote] }
    f.drafts.setUserContent(content)
    const key = 'conversation:conversation-a:branch-a'
    const snapshot = f.drafts.snapshot(key)
    f.drafts.confirmOpen(snapshot, { content, draftId: snapshot.draftId, executionConfig: { approvalPolicy: snapshot.approvalPolicy, executionProfile: snapshot.executionProfile }, modelSelection: null, revision: 1, scope: { kind: 'conversation_branch', conversationId: 'conversation-a', branchId: 'branch-a' }, updatedAt: '2026-10-02T00:00:00.000Z' })
    f.api.chat.startTurn.mockResolvedValue({ conversationId: 'conversation-a', branchId: 'branch-a', run: { ...f.run, status: 'queued' }, draftReceipt: { draftId: snapshot.draftId, sourceRevision: 1, committedRevision: 2 } })
    expect(await f.execution.send({ content: '', userContent: content })).toBe(true)
    expect(f.drafts.snapshot(key).content).toEqual(createBuddyUserContent())
    expect(f.drafts.snapshot(key).revision).toBe(2)
  })

  it('keeps the confirmed review and resources when its revision changes before submission', async () => {
    const f = createFixture()
    f.projectedRuns.value = []
    f.selectedModel.value = { modelId: 'model-a', providerId: 'provider-a' } as LocalRuntimeModelOption
    const content = { ...createBuddyUserContent('/review inspect only'), panelResourceIds: ['resource-a'] }
    f.drafts.setUserContent(content)
    const key = 'conversation:conversation-a:branch-a'
    const snapshot = f.drafts.snapshot(key)
    f.drafts.confirmOpen(snapshot, {
      content,
      draftId: snapshot.draftId,
      executionConfig: { approvalPolicy: snapshot.approvalPolicy, executionProfile: snapshot.executionProfile },
      modelSelection: null,
      revision: 1,
      scope: { kind: 'conversation_branch', conversationId: 'conversation-a', branchId: 'branch-a' },
      updatedAt: '2026-09-08T00:00:00.000Z',
    })
    f.api.chat.startTurn.mockRejectedValue(new Error(formatLocalChatPublicError({ code: 'DRAFT_CONFLICT', retryable: false })))
    const confirmed = f.drafts.snapshot(key)

    expect(await f.execution.send({ content: '/review inspect only', userContent: content })).toBe(false)
    expect(f.drafts.snapshot(key)).toEqual(confirmed)
    expect(f.error.value).toContain('input changed')
    expect(f.projectedRuns.value).toEqual([])
    expect(f.api.chat.startTurn.mock.calls).toEqual([[expect.objectContaining({ draftId: snapshot.draftId, expectedRevision: 1 })]])
  })
})

describe('model selection before submission', () => {
  function prepare(route: 'start' | 'queue' | 'mailbox' = 'queue') {
    const f = createFixture()
    const key = 'conversation:conversation-a:branch-a'
    f.selectedModel.value = { modelId: 'model-b', providerId: 'provider-a' } as LocalRuntimeModelOption
    f.drafts.setModelSelection({ modelId: 'model-b', providerId: 'provider-a', reasoning: null, serviceTier: null })
    const snapshot = f.drafts.snapshot(key)
    const remote = {
      content: snapshot.content,
      draftId: snapshot.draftId,
      executionConfig: { approvalPolicy: snapshot.approvalPolicy, executionProfile: snapshot.executionProfile },
      modelSelection: snapshot.modelSelection,
      revision: 1,
      scope: { kind: 'conversation_branch' as const, conversationId: 'conversation-a', branchId: 'branch-a' },
      updatedAt: '2026-10-27T00:00:00.000Z',
    }
    f.drafts.confirmOpen(snapshot, remote)
    const target = { conversationId: 'conversation-a', branchId: 'branch-a', rootRunId: 'run-a', runId: route === 'mailbox' ? 'partner-run' : 'run-a' }
    f.actorInput.target.value = route === 'start' ? null : target
    f.actorInput.mailboxTarget.value = route === 'mailbox' ? target : null
    f.actorInput.delivery.value = { mode: 'current', actorId: route === 'mailbox' ? 'partner' : 'default', target: route === 'start' ? null : { rootRunId: target.rootRunId, runId: target.runId } }
    if (route === 'start')
      f.projectedRuns.value = []
    const result = { id: 'queued', conversationId: 'conversation-a', branchId: 'branch-a', run: { ...f.run, status: 'queued' }, draftReceipt: { draftId: snapshot.draftId, sourceRevision: 1, committedRevision: 2 } }
    f.api.chat.enqueue.mockResolvedValue(result)
    f.api.chat.startTurn.mockResolvedValue(result)
    f.api.executions.sendDraft.mockResolvedValue({ ...remote, revision: 2, content: createBuddyUserContent() })
    const barrier = deferred<boolean>()
    f.flushModelSelection.mockImplementation(() => barrier.promise)
    return { ...f, key, remote, target, barrier }
  }

  it.each(['start', 'queue', 'mailbox'] as const)('waits for the selected model before accepting %s input', async (route) => {
    const f = prepare(route)
    const delivery = f.actorInput.delivery.value
    const sending = f.execution.send('pending input')
    await Promise.resolve()
    expect(f.execution.isSending.value).toBe(true)
    expect(f.drafts.draft.value).toBe('pending input')
    expect([f.api.chat.startTurn, f.api.chat.enqueue, f.api.executions.sendDraft].flatMap(api => api.mock.calls)).toEqual([])
    f.actorInput.delivery.value = { mode: 'current', actorId: 'other', target: { rootRunId: 'other-root', runId: 'other-run' } }
    f.actorInput.mailboxTarget.value = null
    f.barrier.resolve(true)

    expect(await sending).toBe(true)
    const request = (route === 'start' ? f.api.chat.startTurn : route === 'queue' ? f.api.chat.enqueue : f.api.executions.sendDraft).mock.calls[0]![0]
    expect(request).toMatchObject({ draftId: f.remote.draftId, expectedRevision: 1, delivery })
    if (route === 'mailbox')
      expect(request).toMatchObject(f.target)
    expect(f.drafts.draft.value).toBe('')
    expect(f.execution.isSending.value).toBe(false)
  })

  it.each(['reported', 'rejected'] as const)('retains the draft and failure when model persistence is %s', async (failure) => {
    const f = prepare()
    f.error.value = 'Model selection could not be saved'
    const original = f.drafts.snapshot(f.key)
    const sending = f.execution.send('pending input')
    if (failure === 'reported')
      f.barrier.resolve(false)
    else
      f.barrier.reject(new Error(formatLocalChatPublicError({ code: 'PROVIDER_UNAVAILABLE', retryable: false })))

    expect(await sending).toBe(false)
    expect(f.drafts.snapshot(f.key)).toEqual(original)
    expect([f.api.chat.startTurn, f.api.chat.enqueue, f.api.executions.sendDraft].flatMap(api => api.mock.calls)).toEqual([])
    expect(f.execution.isSending.value).toBe(false)
    expect(f.error.value).toBeTruthy()
    if (failure === 'reported')
      expect(f.error.value).toBe('Model selection could not be saved')
    else
      expect(f.error.value).not.toBe('Model selection could not be saved')
  })

  it('keeps the original task target and does not clear a new view while waiting for the model', async () => {
    const f = prepare()
    const sending = f.execution.send('pending input')
    f.navigate('task')
    f.barrier.resolve(true)

    expect(await sending).toBe(true)
    expect(f.api.chat.enqueue.mock.calls[0]![0]).toMatchObject({ draftId: f.remote.draftId, expectedRevision: 1, delivery: { actorId: 'default', target: { rootRunId: 'run-a', runId: 'run-a' } } })
    expect(f.drafts.snapshot(f.key).content).toEqual(createBuddyUserContent())
    expect(f.drafts.draft.value).toBe('current view input')
    expect(f.error.value).toBe('current view status')
  })

  it('does not submit a later saved draft revision after the model wait', async () => {
    const f = prepare()
    const sending = f.execution.send('pending input')
    f.drafts.updateComposerContent('new unsent input', null)
    const newer = f.drafts.snapshot(f.key)
    f.drafts.confirmOpen(newer, { ...f.remote, content: newer.content, revision: 2 })
    f.barrier.resolve(true)

    expect(await sending).toBe(false)
    expect(f.api.chat.enqueue.mock.calls).toEqual([])
    expect(f.drafts.draft.value).toBe('new unsent input')
    expect(f.drafts.snapshot(f.key).revision).toBe(2)
    expect(f.error.value).toBe('Draft changed')
  })

  it('submits the latest saved text when it changes after the model barrier', async () => {
    const f = prepare()
    const save = deferred<boolean>()
    f.persistWorkspaceState.mockImplementation(() => save.promise)
    const sending = f.execution.send('pending input')
    f.barrier.resolve(true)
    await vi.waitUntil(() => f.persistWorkspaceState.mock.calls.length > 0)
    f.drafts.updateComposerContent('latest saved input', null)
    const newer = f.drafts.snapshot(f.key)
    f.drafts.confirmOpen(newer, { ...f.remote, content: newer.content, revision: 2 })
    f.api.chat.enqueue.mockResolvedValue({ draftReceipt: { draftId: newer.draftId, sourceRevision: 2, committedRevision: 3 } })
    save.resolve(true)

    expect(await sending).toBe(true)
    expect(f.api.chat.enqueue.mock.calls[0]![0]).toMatchObject({ draftId: newer.draftId, expectedRevision: 2, delivery: { actorId: 'default', target: { rootRunId: 'run-a', runId: 'run-a' } } })
    expect(f.drafts.draft.value).toBe('')
    expect(f.drafts.snapshot(f.key).revision).toBe(3)
  })

  it.each(['model', 'actor', 'permissions', 'participants'] as const)('preserves the draft when %s changes during workspace save after the model barrier', async (change) => {
    const f = prepare()
    const save = deferred<boolean>()
    f.persistWorkspaceState.mockImplementation(() => save.promise)
    const sending = f.execution.send('pending input')
    f.barrier.resolve(true)
    await vi.waitUntil(() => f.persistWorkspaceState.mock.calls.length > 0)
    if (change === 'model')
      f.drafts.setModelSelection({ ...f.remote.modelSelection!, modelId: 'model-c' })
    else if (change === 'actor')
      f.drafts.setUserContent({ ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'other', name: 'Other' }, { type: 'text', text: 'new target' }] }] })
    else if (change === 'permissions')
      f.drafts.setPermissionSettings({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    else
      f.drafts.setParticipants({ leaderId: 'other', actorIds: ['other'] })
    const newer = f.drafts.snapshot(f.key)
    f.drafts.confirmOpen(newer, { ...f.remote, content: newer.content, modelSelection: newer.modelSelection, participants: newer.participants, executionConfig: { approvalPolicy: newer.approvalPolicy, executionProfile: newer.executionProfile }, revision: 2 })
    save.resolve(true)

    expect(await sending).toBe(false)
    expect(f.api.chat.enqueue.mock.calls).toEqual([])
    expect(f.drafts.snapshot(f.key).content).toEqual(newer.content)
    expect(f.drafts.snapshot(f.key).modelSelection).toEqual(newer.modelSelection)
    expect(f.drafts.snapshot(f.key).revision).toBe(2)
    expect(f.error.value).toBe('Draft changed')
  })
})

describe('addressed role input', () => {
  function prepare() {
    const f = createFixture()
    f.selectedModel.value = { modelId: 'model-a', providerId: 'provider-a' } as LocalRuntimeModelOption
    f.actorInput.target.value = { conversationId: 'conversation-a', branchId: 'branch-a', rootRunId: 'run-a', runId: 'partner-run' }
    f.actorInput.mailboxTarget.value = f.actorInput.target.value
    f.actorInput.delivery.value = { mode: 'current', actorId: 'partner', target: { rootRunId: 'run-a', runId: 'partner-run' } }
    const content: BuddyUserContentV1 = { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'partner', name: 'Partner' }, { type: 'text', text: ' Continue this work' }] }] }
    f.drafts.setUserContent(content)
    const key = 'conversation:conversation-a:branch-a'
    const snapshot = f.drafts.snapshot(key)
    f.drafts.confirmOpen(snapshot, {
      content,
      draftId: snapshot.draftId,
      executionConfig: { approvalPolicy: snapshot.approvalPolicy, executionProfile: snapshot.executionProfile },
      modelSelection: null,
      revision: 1,
      scope: { kind: 'conversation_branch', conversationId: 'conversation-a', branchId: 'branch-a' },
      updatedAt: '2026-10-13T00:00:00.000Z',
    })
    return { ...f, key, snapshot, content }
  }

  it.each([true, false])('retains an unavailable addressed draft without falling back to a new turn, root active: %s', async (active) => {
    const f = prepare()
    if (!active)
      f.projectedRuns.value = []
    f.api.executions.sendDraft.mockResolvedValue(null)
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(false)
    expect(f.api.chat.enqueue.mock.calls).toEqual([])
    expect(f.api.chat.startTurn.mock.calls).toEqual([])
    expect(f.drafts.snapshot(f.key).content).toEqual(f.content)
    expect(f.error.value).toContain('draft is kept')
  })

  it('queues next-round input bound to the older child even when no root is active', async () => {
    const f = prepare()
    f.projectedRuns.value = []
    f.actorInput.delivery.value = { ...f.actorInput.delivery.value!, mode: 'next' }
    f.api.chat.enqueue.mockResolvedValue({ id: 'next', conversationId: 'conversation-a', branchId: 'branch-a', draftReceipt: { draftId: f.snapshot.draftId, sourceRevision: 1, committedRevision: 2 } })
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(true)
    expect(f.api.chat.enqueue.mock.calls[0]?.[0]).toMatchObject({ delivery: { mode: 'next', actorId: 'partner', target: { rootRunId: 'run-a', runId: 'partner-run' } } })
    expect(f.api.executions.sendDraft.mock.calls).toEqual([])
    expect(f.api.chat.startTurn.mock.calls).toEqual([])
    expect(f.drafts.draft.value).toBe('')
  })

  it('retries the same delivery and request id when the preference changes after an unclear acknowledgement', async () => {
    const f = prepare()
    f.actorInput.mailboxTarget.value = null
    f.api.chat.enqueue.mockRejectedValue(new Error('Offline'))
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(false)
    const first = f.api.chat.enqueue.mock.calls[0]![0]
    expect(first.delivery).toEqual(f.actorInput.delivery.value)
    f.actorInput.delivery.value = { ...f.actorInput.delivery.value!, mode: 'next' }
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(false)
    const second = f.api.chat.enqueue.mock.calls[1]![0]
    expect(second.requestId).toBe(first.requestId)
    expect(second.delivery).toEqual(first.delivery)
    expect(f.drafts.snapshot(f.key).content).toEqual(f.content)
  })

  it('retries the accepted identity after a lost acknowledgement even if the actor has already finished', async () => {
    const f = prepare()
    f.api.executions.sendDraft.mockRejectedValueOnce(new Error('Connection lost'))
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(false)
    expect(f.drafts.snapshot(f.key).content).toEqual(f.content)
    expect(f.api.chat.enqueue.mock.calls).toEqual([])
    expect(f.api.chat.startTurn.mock.calls).toEqual([])
    expect(f.error.value).toBeTruthy()
    const first = f.api.executions.sendDraft.mock.calls[0]![0]
    f.actorInput.target.value = null
    f.actorInput.mailboxTarget.value = null
    f.actorInput.delivery.value = { mode: 'current', actorId: 'partner', target: null }
    f.projectedRuns.value = []
    f.api.executions.sendDraft.mockResolvedValue({
      draftId: f.snapshot.draftId,
      revision: 2,
      scope: { kind: 'conversation_branch', conversationId: 'conversation-a', branchId: 'branch-a' },
      executionConfig: { approvalPolicy: f.snapshot.approvalPolicy, executionProfile: f.snapshot.executionProfile },
      modelSelection: null,
      content: createBuddyUserContent(),
      updatedAt: '2026-10-13T00:01:00.000Z',
    })
    expect(await f.execution.send({ content: '@Partner Continue this work', userContent: f.content })).toBe(true)
    expect(f.api.executions.sendDraft.mock.calls[1]![0]).toEqual(first)
    expect(f.api.chat.enqueue.mock.calls).toEqual([])
    expect(f.api.chat.startTurn.mock.calls).toEqual([])
    expect(f.drafts.draft.value).toBe('')
  })
})

function createFixture() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => {
    const session = useChatSession()
    session.activateConversation(conversation('conversation-a'))
    const targetKey = computed(() => `conversation:${session.activeConversationId.value}:${session.activeBranchId.value}`)
    const drafts = useChatDrafts({ onChange: () => {}, targetKey })
    drafts.updateComposerContent('pending input', null)
    const run: LocalRun = {
      buddyId: 'default',
      approvalPolicy: 'policy',
      branchId: 'branch-a',
      completedAt: null,
      conversationId: 'conversation-a',
      errorCode: null,
      executionProfile: 'workspace_write',
      id: 'run-a',
      modelId: 'model-a',
      providerId: 'provider-a',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-09-08T00:00:00.000Z',
      status: 'running',
      triggeringMessageId: 'message-a',
    }
    const projectedRuns = shallowRef<ReadonlyArray<LocalRun>>([run])
    const error = shallowRef<string | null>(null)
    const pending = deferred<LocalRun>()
    const composerTarget = useComposerTarget({ drafts, conversationId: session.activeConversationId, branchId: session.activeBranchId, persist: async () => true })
    const actorInput = {
      target: shallowRef<ExecutionTarget | null>(null),
      mailboxTarget: shallowRef<ExecutionTarget | null>(null),
      delivery: shallowRef<BuddyInputDelivery | undefined>(),
      execution: shallowRef<LocalExecution | null>(null),
    }
    const api = { executions: { sendDraft: vi.fn() }, chat: { listQueue: async () => [], enqueue: vi.fn(), cancelQueued: vi.fn(), steerQueued: vi.fn(), cancel: () => pending.promise, executeCommand: vi.fn(), startTurn: vi.fn() } }
    const selectedModel = shallowRef<LocalRuntimeModelOption | null>(null)
    const flushModelSelection = vi.fn(async () => true)
    const persistWorkspaceState = vi.fn(async () => true)
    const execution = useChatTurnExecution({
      actorInput,
      composerTarget,
      activeRun: computed(() => projectedRuns.value.find(item => item.status === 'running') ?? null),
      api,
      approvalPolicy: drafts.approvalPolicy,
      canSendDraft: shallowRef(true),
      drafts,
      draftChangedMessage: () => 'Draft changed',
      draftScopeKey: targetKey,
      executionProfile: drafts.executionProfile,
      flushModelSelection,
      getRunTerminationMessage: () => 'Run ended',
      isUpdatingPermissionSettings: shallowRef(false),
      language: shallowRef('en-US'),
      modelSelection: { selectedModel },
      onActionCommandRunStarted: () => {},
      persistWorkspaceState,
      runSync: {
        refreshActiveConversation: async () => {},
        applyRunStart: () => {},
        upsertRuns: (runs) => {
          const byId = new Map(projectedRuns.value.map(item => [item.id, item]))
          runs.forEach(item => byId.set(item.id, item))
          projectedRuns.value = [...byId.values()]
        },
      },
      runtimeSupervisor: { runtimeState: shallowRef({ lastError: null, pid: null, restartAttempt: 0, status: 'ready' }) },
      session,
      setErrorMessage: value => error.value = value,
      taskIndexData: { refreshIndex: async () => {} },
      unavailableCommandMessage: () => 'Command unavailable',
    })
    function navigate(target: 'task' | 'branch' | 'return-to-task' | 'return-to-branch') {
      if (target === 'branch' || target === 'return-to-branch') {
        session.setActiveBranch('branch-b')
        if (target === 'return-to-branch')
          session.setActiveBranch('branch-a')
      }
      else {
        session.activateConversation(conversation('conversation-b'))
        if (target === 'return-to-task')
          session.activateConversation(conversation('conversation-a'))
      }
      projectedRuns.value = []
      drafts.updateComposerContent('current view input', null)
      error.value = 'current view status'
    }
    return { actorInput, api, drafts, error, execution, flushModelSelection, navigate, pending, persistWorkspaceState, projectedRuns, run, scope, selectedModel }
  })!
}

function conversation(id: string): LocalConversation {
  return {
    buddyId: 'default',
    activeBranchId: 'branch-a',
    approvalPolicy: 'policy',
    createdAt: '2026-09-08T00:00:00.000Z',
    deletedAt: null,
    executionProfile: 'workspace_write',
    id,
    modelSelection: null,
    spaceId: null,
    title: id,
    updatedAt: '2026-09-08T00:00:00.000Z',
  }
}
