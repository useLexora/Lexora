import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRun } from '@buddy-shared/runs/runApi'
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
  it('applies cancellation to the current projection and preserves its Draft', async () => {
    const fixture = createFixture()
    const cancelling = fixture.execution.cancelActiveRun()
    fixture.pending.resolve({ ...fixture.run, status: 'cancelled' })
    await cancelling

    expect(fixture.projectedRuns.value).toEqual([{ ...fixture.run, status: 'cancelled' }])
    expect(fixture.drafts.draft.value).toBe('pending input')
    expect(fixture.error.value).toBeNull()
    expect(fixture.execution.isSending.value).toBe(false)
  })

  it('reports a cancellation failure only in the originating view', async () => {
    const fixture = createFixture()
    const cancelling = fixture.execution.cancelActiveRun()
    fixture.pending.reject(new Error('cancel failed'))
    await cancelling

    expect(fixture.error.value).toBeTruthy()
    expect(fixture.projectedRuns.value).toEqual([fixture.run])
    expect(fixture.drafts.draft.value).toBe('pending input')
    expect(fixture.execution.isSending.value).toBe(false)
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
    expect(fixture.execution.isSending.value).toBe(false)
  })

  it.each(['task', 'branch', 'return-to-task', 'return-to-branch'] as const)(
    'ignores a cancellation result after navigating to %s',
    async (navigation) => {
      const fixture = createFixture()
      const cancelling = fixture.execution.cancelActiveRun()
      fixture.navigate(navigation)
      fixture.pending.resolve({ ...fixture.run, status: 'cancelled' })
      await cancelling

      expect(fixture.projectedRuns.value).toEqual([])
      expect(fixture.drafts.draft.value).toBe('current view input')
      expect(fixture.error.value).toBe('current view status')
      expect(fixture.execution.isSending.value).toBe(false)
    },
  )

  it.each(['task', 'branch', 'return-to-task', 'return-to-branch'] as const)(
    'ignores a cancellation error after navigating to %s',
    async (navigation) => {
      const fixture = createFixture()
      const cancelling = fixture.execution.cancelActiveRun()
      fixture.navigate(navigation)
      fixture.pending.reject(new Error('old cancellation failed'))
      await cancelling

      expect(fixture.projectedRuns.value).toEqual([])
      expect(fixture.drafts.draft.value).toBe('current view input')
      expect(fixture.error.value).toBe('current view status')
      expect(fixture.execution.isSending.value).toBe(false)
    },
  )
})

describe('turn submission conflicts', () => {
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
    const api = { chat: { listQueue: async () => [], enqueue: vi.fn(), cancelQueued: vi.fn(), steerQueued: vi.fn(), cancel: () => pending.promise, executeCommand: vi.fn(), startTurn: vi.fn() } }
    const selectedModel = shallowRef<LocalRuntimeModelOption | null>(null)
    const execution = useChatTurnExecution({
      composerTarget,
      activeRun: computed(() => projectedRuns.value.find(item => item.status === 'running') ?? null),
      api,
      approvalPolicy: drafts.approvalPolicy,
      canSendDraft: shallowRef(true),
      drafts,
      draftChangedMessage: () => 'Draft changed',
      draftScopeKey: targetKey,
      executionProfile: drafts.executionProfile,
      getRunTerminationMessage: () => 'Run ended',
      isUpdatingPermissionSettings: shallowRef(false),
      language: shallowRef('en-US'),
      modelSelection: { selectedModel },
      onActionCommandRunStarted: () => {},
      persistWorkspaceState: async () => true,
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
    return { api, drafts, error, execution, navigate, pending, projectedRuns, run, scope, selectedModel }
  })!
}

function conversation(id: string): LocalConversation {
  return {
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
