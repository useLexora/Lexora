import type { ExecutionsChanged } from '../../../../../shared/executions/executionPresentationApi'
import type { BuddyExecutionProfile } from '../../../../../shared/permissions/executionProfile'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../../shared/buddies/buddySettings'
import { createBuddyUserContent } from '../../../../../shared/conversation/buddyUserContent'
import { resolveBuddyPermissionSettings } from '../../../../../shared/permissions/permissionMode'
import { BuddiesService } from '../../../buddies/BuddiesService'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { isReviewUserMessage } from '../../../chat/buddyReviewPrompt'
import { ComposerDraftService } from '../../../chat/ComposerDraftService'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import { createExecutionStorageFixture, executionNow } from '../../../storage/__tests__/executionFixture'
import { createApprovalRepository } from '../../../storage/approvalRepository'
import { createArtifactRepository } from '../../../storage/artifactRepository'
import { createChatQueueRepository } from '../../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../../storage/composerDraftRepository'
import { hashChildAdmissionRequest } from '../../../storage/executionRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { createUsageRepository } from '../../../storage/usageRepository'
import { UsageService } from '../../../usage/UsageService'
import { ExecutionComposerInputService } from '../ExecutionComposerInputService'
import { ExecutionCoordinator } from '../ExecutionCoordinator'
import { ExecutionPresentationService } from '../ExecutionPresentationService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture() {
  const storage = createExecutionStorageFixture()
  storage.conversations.createMessage({ id: 'goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Goal' }, createdAt: executionNow })
  const directory = await mkdtemp(join(tmpdir(), 'lexora-execution-presentation-'))
  const events = createRunEventLog({ database: storage.database, conversationsDirectory: directory })
  const mailbox = createMailboxRepository(storage.database)
  const lifecycle = new RunLifecycleService({ eventLog: events, repository: storage.runs })
  const mutations = new MutationCoordinator()
  const usage = createUsageRepository(storage.database)
  const usageService = new UsageService({ eventLog: events, repository: usage })
  const coordinator = new ExecutionCoordinator({ listIncomplete: () => storage.runs.listIncomplete(), executions: storage.executions, mailbox, events, lifecycle, mutations, readResult: () => '', launchChild: async () => {
    throw new Error('Not used')
  }, stopExecution: async () => false })
  const service = new ExecutionPresentationService({
    approvals: createApprovalRepository(storage.database),
    conversations: storage.conversations,
    runs: storage.runs,
    executions: storage.executions,
    mailbox,
    buddies: new BuddiesService(storage.buddies),
    coordinator,
    mutations,
    events,
    artifacts: createArtifactRepository(storage.database),
    changes: { listSummariesForRuns: () => [] },
    usage,
    stopExecution: async () => false,
  })
  const drafts = new ComposerDraftService(createComposerDraftRepository(storage.database), async () => {})
  const inputOptions = {
    drafts,
    conversations: storage.conversations,
    executions: storage.executions,
    getRunPermissionCeiling: (runId: string): BuddyExecutionProfile | undefined => {
      const execution = storage.executions.find(runId)
      if (execution?.fileAccessCeiling === 'read_only' || execution?.run.actorSnapshot?.settings.limits.fileAccess === 'read_only')
        return 'read_only'
      return execution?.run.triggeringMessageId && isReviewUserMessage(storage.conversations.findMessageById(execution.run.triggeringMessageId)?.content) ? 'read_only' : undefined
    },
    mailbox,
    delivery: service,
  }
  const composerInput = new ExecutionComposerInputService(inputOptions)
  cleanups.push(async () => {
    await drafts.dispose()
    service.dispose()
    usageService.dispose()
    await coordinator.dispose()
    await lifecycle.dispose()
    await events.close()
    mutations.dispose()
    storage.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...storage, events, mailbox, mutations, coordinator, service, usage, usageService, drafts, composerInput, inputOptions }
}

const scope = { conversationId: 'conversation', branchId: 'branch' }
const target = { ...scope, rootRunId: 'root', runId: 'child' }

describe('execution presentation ownership', () => {
  it('derives approval waiting from pending approvals even when model progress still says preparing', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child', f.actor.id))
    await f.coordinator.begin('child', new AbortController().signal)
    await f.events.append({ runId: 'child', type: 'run.progress', payload: { phase: 'preparing', toolName: 'bash' } })
    for (const id of ['first', 'second']) {
      await f.events.append({ runId: 'child', type: 'approval.requested', payload: {
        id,
        runId: 'child',
        toolCallId: id,
        kind: 'shell',
        status: 'pending',
        summary: 'Confirm execution',
        payload: { card: 'shell', command: 'pwd', toolName: 'bash', allowForTurn: true, reuseScopes: ['turn'] },
        createdAt: executionNow,
        resolvedAt: null,
      } })
    }
    expect(f.service.list(scope).find(record => record.runId === 'child')?.waitingFor).toBe('approval')
    expect(f.service.list(scope).find(record => record.runId === 'root')?.waitingFor).not.toBe('approval')
    await f.events.append({ runId: 'child', type: 'approval.resolved', payload: { id: 'first', status: 'approved', resolvedAt: executionNow } })
    expect((await f.service.detail(target)).execution.waitingFor).toBe('approval')
    await f.events.append({ runId: 'child', type: 'approval.resolved', payload: { id: 'second', status: 'denied', resolvedAt: executionNow } })
    expect(f.service.list(scope).find(record => record.runId === 'child')?.waitingFor).toBeNull()
  })

  it('shows the real caller tree and routes a user answer to its question after the main actor changes', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    await f.coordinator.begin('child', new AbortController().signal)
    await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'question', questionId: 'question', targetRunId: 'child', targetGeneration: 0, text: 'Choose a destination' })
    f.conversations.addMember({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
    f.conversations.setBuddy({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
    expect(f.service.list(scope).find(record => record.runId === 'child')).toMatchObject({ parentRunId: 'root', kind: 'npc_child', waitingFor: 'answer', canAnswer: true, questions: [{ questionId: 'question', open: true, answered: false }] })
    await expect(f.service.answer({ ...target, runId: 'root', questionId: 'question', text: 'wrong target' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(f.service.answer({ ...target, questionId: 'question', text: '/chosen/destination' })).resolves.toEqual({ accepted: true })
    expect(f.mailbox.listUnconsumed('child')).toEqual([expect.objectContaining({ kind: 'answer', questionId: 'question', text: '/chosen/destination', targetRunId: 'child' })])
    expect(f.service.list(scope).find(record => record.runId === 'child')?.questions).toEqual([{ questionId: 'question', text: 'Choose a destination', audience: 'user', open: false, answered: true }])
    expect((await f.service.detail(target)).inputs).toEqual([expect.objectContaining({ kind: 'answer', text: '/chosen/destination' })])
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
    await f.service.cancel(target)
    await expect(f.service.answer({ ...target, questionId: 'question', text: '/chosen/destination' })).resolves.toEqual({ accepted: true })
    await expect(f.service.answer({ ...target, questionId: 'question', text: '/another/destination' })).rejects.toMatchObject({ code: 'conflict' })
    expect((await f.service.detail(target)).inputs).toHaveLength(1)
    expect(f.executions.find('child')).toMatchObject({ phase: 'closed', run: { status: 'cancelled' } })
  })

  it('keeps private results out of list and notices, with explicit detail scoped to the visible root', async () => {
    const f = await fixture()
    const notices: ExecutionsChanged[] = []
    f.service.onDidChange(notice => notices.push(notice))
    f.executions.admitChild(f.child('child'))
    await f.events.append({ runId: 'child', type: 'message.completed', payload: { messageId: 'private', role: 'assistant', stopReason: 'completed', content: { text: 'Private child result' } } })
    expect(JSON.stringify(f.service.list(scope))).not.toContain('Private child result')
    expect(notices.at(-1)).toMatchObject({ conversationId: 'conversation', rootRunId: 'root' })
    expect(Object.keys(notices.at(-1)!).sort()).toEqual(['conversationId', 'revision', 'rootRunId', 'sourceId'])
    expect((await f.service.detail(target)).result).toBe('Private child result')
    const beforeProgress = notices.length
    await f.events.append({ runId: 'root', type: 'run.progress', payload: { phase: 'model_responding', toolName: null } })
    await expect.poll(() => notices.length).toBeGreaterThan(beforeProgress)
    expect(notices.at(-1)).toMatchObject({ rootRunId: 'root', conversationId: 'conversation' })
    expect(f.service.list(scope).find(record => record.runId === 'root')?.progress?.phase).toBe('model_responding')
    f.conversations.createBranch({ id: 'sibling', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: executionNow, activate: false })
    await expect(f.service.detail({ ...target, branchId: 'sibling' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.service.list({ ...scope, branchId: 'sibling' })).toEqual([])
    expect(() => f.service.list({ ...scope, branchId: 'missing' })).toThrow()
  })

  it('keeps same-role ordinals stable when later children sort earlier by ID and when executions finish', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('z-child'))
    f.executions.admitChild(f.child('a-child'))
    const ordinals = () => f.service.list(scope).map(record => [record.runId, record.ordinal])
    expect(ordinals()).toEqual([['root', null], ['z-child', 1], ['a-child', 2]])
    await f.service.cancel({ ...target, runId: 'z-child' })
    f.executions.admitChild(f.child('earlier-child'))
    expect(ordinals()).toEqual([['root', null], ['z-child', 1], ['a-child', 2], ['earlier-child', 3]])
    expect((await f.service.detail({ ...target, runId: 'a-child' })).execution.ordinal).toBe(2)
    await f.events.replayAll()
    expect(ordinals()).toEqual([['root', null], ['z-child', 1], ['a-child', 2], ['earlier-child', 3]])
  })

  it('closes cancelled questions without reviving the child and reports unsettled resources separately', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'question', questionId: 'question', targetRunId: 'child', targetGeneration: 0, text: 'Choose' })
    await expect(f.service.cancel(target)).resolves.toEqual({ cancelled: true })
    await expect(f.service.answer({ ...target, questionId: 'question', text: 'Late' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.mailbox.findQuestion('question')?.answer).toBeNull()
    f.mutations.restoreHazard({ runId: 'child', invocationId: 'process', claims: [{ kind: 'tree', canonicalPath: '/work/reports' }], reason: 'PROCESS_CLEANUP_UNKNOWN' })
    expect(f.service.list(scope).find(record => record.runId === 'child')).toMatchObject({ status: 'cancelled', canAnswer: false, canCancel: false, cleanup: 'degraded', affectedResources: [{ kind: 'path', path: '/work/reports' }], questions: [{ open: false, answered: false }] })
  })

  it('preserves exact per-run usage through nested work, continuation, replay and later roots', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('actor', f.actor.id))
    f.executions.claimWorking(f.fence('actor'))
    f.executions.admitChild(f.child('nested', f.npc.id, 'actor'))
    f.executions.admitChild(f.child('first'))
    function settle(runId: string) {
      f.runs.reconcileTerminal(runId, 'completed', executionNow, null)
      f.executions.recordCleanup(runId, 'clean', null)
    }
    function resume(runId: string, previousRunId: string, callerId = 'root') {
      const input = { ...f.child(runId, f.npc.id, callerId), work: { contextMode: 'isolated' as const, contextSourceIds: [], previousRunId } }
      return f.executions.admitChild({ ...input, requestHash: hashChildAdmissionRequest(input) }).execution
    }
    settle('first')
    resume('second', 'first')

    for (const [runId, input, purpose] of [
      ['root', 10, 'turn'],
      ['root', 999, 'cache_warm'],
      ['actor', 20, 'turn'],
      ['nested', 30, 'turn'],
      ['first', 40, 'turn'],
      ['second', 999, 'cache_warm'],
      ['second', 50, 'turn'],
      ['second', 5, 'compaction'],
    ] as const) {
      const record = {
        runId,
        purpose,
        sourceEntryId: `${runId}-${purpose}`,
        createdAt: executionNow,
        model: 'fixture',
        provider: 'fixture',
        usage: { input, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: input + 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      await f.usageService.record(record)
      expect(await f.usageService.record(record)).toBeNull()
    }
    const listUsage = () => f.service.list(scope).map(({ runId, rootRunId, usage }) => ({ runId, rootRunId, usage }))
    const before = listUsage()
    expect(before.map(record => [record.runId, record.usage?.inputTokens])).toEqual([
      ['root', 10],
      ['actor', 20],
      ['nested', 30],
      ['first', 40],
      ['second', 55],
    ])
    const detail = await f.service.detail({ ...target, runId: 'second' })
    expect(detail.usage).toEqual({ inputTokens: 55, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2 })
    expect(detail.execution.usage).toEqual(detail.usage)
    expect(before.find(record => record.runId === 'second')?.usage).toEqual(detail.usage)
    await f.events.replayAll()
    expect(listUsage()).toEqual(before)

    for (const runId of ['actor', 'nested', 'second', 'root'])
      settle(runId)
    f.conversations.createMessage({ id: 'next-goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Continue the work' }, createdAt: executionNow })
    f.runs.create({ ...f.runs.findById('root')!, id: 'next-root', rootRunId: 'next-root', triggeringMessageId: 'next-goal', status: 'running', completedAt: null })
    resume('third', 'second', 'next-root')
    expect(listUsage().filter(record => record.rootRunId === 'next-root')).toEqual([
      { runId: 'next-root', rootRunId: 'next-root', usage: null },
      { runId: 'third', rootRunId: 'next-root', usage: null },
    ])
    await f.usageService.record({
      runId: 'third',
      purpose: 'turn',
      sourceEntryId: 'third-turn',
      createdAt: executionNow,
      model: 'fixture',
      provider: 'fixture',
      usage: { input: 60, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 66, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    })
    expect(listUsage().filter(record => record.rootRunId === 'root')).toEqual(before)
    expect(listUsage().filter(record => record.rootRunId === 'next-root').map(record => [record.runId, record.usage?.inputTokens])).toEqual([['next-root', undefined], ['third', 60]])
  })
  it('delivers a private user supplement once, acknowledges retries after cancellation, and rejects stale or conflicting targets', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.admitChild(f.child('sibling'))
    const messageId = '11111111-1111-4111-8111-111111111111'
    const input = { ...target, messageId, text: 'Keep the requested color.' }
    await expect(f.service.send(input)).resolves.toEqual({ accepted: true })
    await expect(f.service.send(input)).resolves.toEqual({ accepted: true })
    expect(f.mailbox.listUnconsumed('child')).toEqual([expect.objectContaining({ kind: 'supplement', origin: 'user', text: input.text, targetRunId: 'child' })])
    expect(f.mailbox.listUnconsumed('sibling')).toEqual([])
    expect((await f.service.detail(target)).inputs).toEqual([expect.objectContaining({ messageId, text: input.text, state: 'pending' })])
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
    await expect(f.service.send({ ...input, text: 'Conflicting retry' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.service.send({ ...input, runId: 'root' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await f.service.cancel(target)
    await expect(f.service.send(input)).resolves.toEqual({ accepted: true })
    await expect(f.service.send({ ...input, text: 'Conflicting retry' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.service.send({ ...input, messageId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.executions.find('child')).toMatchObject({ phase: 'closed', run: { status: 'cancelled' } })
    expect((await f.service.detail(target)).inputs).toEqual([expect.objectContaining({ messageId, state: 'undelivered' })])
    f.conversations.createBranch({ id: 'other', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: executionNow, activate: true })
    await expect(f.service.send({ ...input, runId: 'sibling', messageId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('pages sanitized process events and counts separate invocations of a reused call ID without leaking the transcript', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.admitChild(f.child('sibling'))
    await f.events.append({ runId: 'root', type: 'tool.started', payload: { toolCallId: 'root-tool', toolName: 'lexora_agents' } })
    await f.events.append({ runId: 'sibling', type: 'tool.started', payload: { toolCallId: 'sibling-tool', toolName: 'read' } })
    await f.events.appendBatch([
      { runId: 'child', type: 'tool.started', payload: { toolCallId: 'first', toolName: 'read' } },
      { runId: 'child', type: 'tool.updated', payload: { toolCallId: 'first', result: 'private progress' } },
      { runId: 'child', type: 'tool.completed', payload: { toolCallId: 'first', result: 'private output' } },
      { runId: 'child', type: 'tool.started', payload: { toolCallId: 'first', toolName: 'read' } },
    ])
    await f.events.appendBatch(Array.from({ length: 503 }, (_, i) => ({ runId: 'child', type: 'message.delta', payload: { messageId: 'private', delta: `private-${i}`, secret: 'not public' } })))
    await f.events.append({ runId: 'child', type: 'run.progress', payload: { phase: 'model_requesting', toolName: null } })
    const first = await f.service.events(target)
    expect(first.events).toHaveLength(500)
    expect(first.hasMore).toBe(true)
    expect(first.events.every(event => !('secret' in event.payload))).toBe(true)
    const second = await f.service.events({ ...target, afterSequence: first.nextSequence })
    expect(second.hasMore).toBe(false)
    expect(second.events[0]?.sequence).toBe(first.nextSequence + 1)
    expect(f.service.list(scope).find(record => record.runId === 'child')).toMatchObject({ toolCount: 2, progress: { phase: 'model_requesting', toolName: null } })
    expect((await f.service.detail(target)).execution.toolCount).toBe(2)
    await f.service.cancel(target)
    await f.events.compactTerminalRun('child')
    expect(f.service.list(scope).find(record => record.runId === 'child')?.toolCount).toBe(2)
    expect(JSON.stringify(f.service.list(scope))).not.toContain('private-')
    await expect(f.service.events({ ...target, runId: 'root', rootRunId: 'child' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
  it('cancels current children while their caller closes without cancelling it or reopening input', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.admitChild(f.child('sibling'))
    f.database.prepare('UPDATE execution_state SET phase = \'closing\' WHERE run_id = \'root\'').run()
    expect(f.service.list(scope).find(record => record.runId === 'child')).toMatchObject({ canCancel: true, canSend: false })
    await expect(f.service.cancelChildren({ ...target, runId: 'root' })).resolves.toEqual({ cancelledRunIds: ['child', 'sibling'] })
    expect(f.service.list(scope).filter(record => record.parentRunId === 'root')).toEqual([
      expect.objectContaining({ runId: 'child', status: 'cancelled', phase: 'closed', canSend: false }),
      expect.objectContaining({ runId: 'sibling', status: 'cancelled', phase: 'closed', canSend: false }),
    ])
    expect(f.executions.find('root')).toMatchObject({ cancelRequestedAt: null, run: { status: 'running' } })
    await expect(f.service.send({ ...target, messageId: '11111111-1111-4111-8111-111111111111', text: 'Late instruction' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

async function inputFixture() {
  const f = await fixture()
  f.executions.admitChild(f.child('child', f.actor.id))
  await f.coordinator.begin('child', new AbortController().signal)
  const content = createBuddyUserContent(' Additional direction')
  const initialContent = { ...content, body: [{ type: 'paragraph' as const, content: [{ type: 'actor_ref' as const, actorId: f.actor.id, name: f.actor.name }, ...content.body[0]!.content] }] }
  const draft = await f.drafts.open({ draftId: 'input-draft', scope: { kind: 'conversation_branch', ...scope }, initialContent, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null })
  return { ...f, draft, input: { ...target, draftId: draft.draftId, expectedRevision: draft.revision } }
}

describe('actor input from the composer', () => {
  it.each([
    { mode: 'read_only', kind: 'supplement' },
    { mode: 'manual_approval', kind: 'answer' },
    { mode: 'full_access', kind: 'supplement' },
  ] as const)('accepts a current $kind after switching to $mode without changing the original run', async ({ mode, kind }) => {
    const f = await inputFixture()
    if (kind === 'answer')
      await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'permission-question', questionId: 'permission-question', targetRunId: 'child', targetGeneration: 0, text: 'Choose a destination' })
    const original = f.runs.findById('child')!
    const executionConfig = resolveBuddyPermissionSettings(mode)
    f.conversations.setPermissionSettings({ id: 'conversation', ...executionConfig, updatedAt: executionNow })
    const draft = await f.drafts.save({ ...f.draft, expectedRevision: f.draft.revision, executionConfig })
    const input = { ...f.input, expectedRevision: draft.revision, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }

    expect((await f.composerInput.send(input))?.content).toEqual(createBuddyUserContent())
    expect((await f.service.detail(target)).inputs).toEqual([expect.objectContaining({ kind, text: '@Reviewer Additional direction' })])
    expect(f.runs.findById('child')).toEqual(original)
  })

  it('rejects stale composer permissions after a live change without consuming the draft', async () => {
    const f = await inputFixture()
    f.conversations.setPermissionSettings({ id: 'conversation', ...resolveBuddyPermissionSettings('read_only'), updatedAt: executionNow })
    const input = { ...f.input, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }

    await expect(f.composerInput.send(input)).rejects.toMatchObject({ code: 'INPUT_DELIVERY_INCOMPATIBLE' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    expect((await f.service.detail(target)).inputs).toEqual([])
  })

  it.each(['review', 'actor', 'ancestor'] as const)('keeps the %s read-only ceiling when the conversation has full access', async (source) => {
    const f = await fixture()
    let runId = 'root'
    let actorId = 'default'
    if (source === 'review') {
      f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify({ userContent: createBuddyUserContent('/review inspect'), resourceSnapshots: [] }), 'goal')
      f.database.prepare('UPDATE runs SET execution_profile = ? WHERE id = ?').run('read_only', 'root')
    }
    else {
      const limitedActorId = source === 'ancestor' ? 'default' : f.actor.id
      const buddy = f.buddies.get(limitedActorId)
      f.buddies.update({ buddyId: buddy.id, expectedRevision: buddy.revision, settings: buddySettingsSchema.parse({ ...buddy.settings, limits: { fileAccess: 'read_only' } }) })
      if (source === 'ancestor') {
        const snapshot = f.snapshot('default')
        f.database.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), 'root')
      }
      const child = f.child('child', f.actor.id)
      child.run.executionProfile = 'read_only'
      child.requestHash = hashChildAdmissionRequest(child)
      f.executions.admitChild(child)
      await f.coordinator.begin('child', new AbortController().signal)
      runId = 'child'
      actorId = f.actor.id
    }
    await f.coordinator.send(runId, { kind: 'question', audience: 'user', messageId: 'ceiling-question', questionId: 'ceiling-question', targetRunId: runId, targetGeneration: 0, text: 'Choose a destination' })
    const original = f.runs.findById(runId)
    const executionConfig = resolveBuddyPermissionSettings('full_access')
    f.conversations.setPermissionSettings({ id: 'conversation', ...executionConfig, updatedAt: executionNow })
    const content = createBuddyUserContent('Use the local directory')
    const initialContent = runId === 'child'
      ? { ...content, body: [{ type: 'paragraph' as const, content: [{ type: 'actor_ref' as const, actorId, name: f.actor.name }, ...content.body[0]!.content] }] }
      : content
    const draft = await f.drafts.open({ draftId: 'ceiling-answer', scope: { kind: 'conversation_branch', ...scope }, initialContent, initialExecutionConfig: executionConfig, initialModelSelection: null })
    const input = { ...scope, rootRunId: 'root', runId, draftId: draft.draftId, expectedRevision: draft.revision, delivery: { mode: 'current' as const, actorId, target: { rootRunId: 'root', runId } } }

    await expect(f.composerInput.send(input)).rejects.toMatchObject({ code: 'INPUT_DELIVERY_INCOMPATIBLE' })
    expect(f.drafts.get(draft.draftId)).toEqual(draft)
    expect(f.mailbox.findQuestion('ceiling-question')).toMatchObject({ open: true, answer: null })
    expect(f.runs.findById(runId)).toEqual(original)

    const readOnly = await f.drafts.save({ ...draft, expectedRevision: draft.revision, executionConfig: resolveBuddyPermissionSettings('read_only') })
    expect((await f.composerInput.send({ ...input, expectedRevision: readOnly.revision }))?.content).toEqual(createBuddyUserContent())
    expect(f.mailbox.findQuestion('ceiling-question')).toMatchObject({ open: false, answer: { targetRunId: runId } })
    expect(f.runs.findById(runId)).toEqual(original)
  })

  it('delivers explicit current input to an older live actor child even after a newer root has completed', async () => {
    const f = await inputFixture()
    const latest = { ...f.runs.findById('root')!, id: 'latest-root', rootRunId: 'latest-root', status: 'completed' as const, triggeringMessageId: 'latest-goal', startedAt: '2026-10-13T00:00:00.000Z' }
    f.runs.create(latest)
    f.conversations.createMessage({ id: 'latest-goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'A later independent task' }, createdAt: latest.startedAt })
    const input = { ...f.input, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }
    expect((await f.composerInput.send(input))?.content).toEqual(createBuddyUserContent())
    expect(f.mailbox.listUnconsumed('child')).toEqual([expect.objectContaining({ kind: 'supplement', origin: 'user', targetRunId: 'child', text: '@Reviewer Additional direction' })])
    expect(f.mailbox.listUnconsumed('latest-root')).toEqual([])
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(2)
  })

  it.each([true, false])('rejects stale explicit current input before or during delivery (closed before: %s) without consuming its draft', async (closedBefore) => {
    const f = await inputFixture()
    const input = { ...f.input, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }
    if (closedBefore)
      await f.service.cancel(target)
    const service = new ExecutionComposerInputService({
      ...f.inputOptions,
      delivery: {
        answer: input => f.service.answer(input),
        send: async (input) => {
          if (!closedBefore)
            await f.service.cancel(target)
          return f.service.send(input)
        },
      },
    })
    await expect(service.send(input)).rejects.toMatchObject({ code: 'INPUT_DELIVERY_TARGET_UNAVAILABLE' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    expect((await f.service.detail(target)).inputs).toEqual([])
  })

  it('confirms an accepted explicit input after lost acknowledgement and target closure without redelivering', async () => {
    const f = await inputFixture()
    const input = { ...f.input, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }
    const service = new ExecutionComposerInputService({
      ...f.inputOptions,
      delivery: {
        answer: input => f.service.answer(input),
        send: async (input) => {
          await f.service.send(input)
          throw new Error('Lost acknowledgement')
        },
      },
    })
    await expect(service.send(input)).rejects.toThrow('Lost acknowledgement')
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    await f.service.cancel(target)
    const cleared = (await f.composerInput.send(input))!
    expect(cleared.content).toEqual(createBuddyUserContent())
    const receipt = (await f.service.detail(target)).inputs
    expect(receipt).toEqual([expect.objectContaining({ kind: 'supplement', text: '@Reviewer Additional direction', state: 'undelivered' })])
    const newer = await f.drafts.save({ draftId: cleared.draftId, expectedRevision: cleared.revision, content: createBuddyUserContent('A new unsent draft'), executionConfig: cleared.executionConfig, modelSelection: null })
    expect(await f.composerInput.send(input)).toEqual(newer)
    expect((await f.service.detail(target)).inputs).toEqual(receipt)
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
  })

  it('supplements an unmentioned current leader actor child and confirms its receipt after the leader changes', async () => {
    const f = await inputFixture()
    f.conversations.setBuddy({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
    const draft = await f.drafts.save({ draftId: f.draft.draftId, expectedRevision: f.draft.revision, content: createBuddyUserContent('Continue with the local directory'), executionConfig: f.draft.executionConfig, modelSelection: null })
    const input = { ...f.input, expectedRevision: draft.revision, delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } }
    const cleared = await f.composerInput.send(input)
    expect(cleared?.content).toEqual(createBuddyUserContent())
    expect(f.mailbox.listUnconsumed('child')).toEqual([expect.objectContaining({ kind: 'supplement', origin: 'user', text: 'Continue with the local directory' })])
    f.conversations.setBuddy({ id: 'conversation', buddyId: 'default', updatedAt: executionNow })
    expect(await f.composerInput.send(input)).toEqual(cleared)
    expect((await f.service.detail(target)).inputs).toHaveLength(1)
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
  })

  it.each(['previous-leader', 'legacy'] as const)('rejects an unmentioned child supplement for %s without consuming the draft', async (reason) => {
    const f = await inputFixture()
    if (reason === 'legacy')
      f.conversations.setBuddy({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
    const draft = await f.drafts.save({ draftId: f.draft.draftId, expectedRevision: f.draft.revision, content: createBuddyUserContent('Unmentioned supplement'), executionConfig: f.draft.executionConfig, modelSelection: null })
    const input = { ...f.input, expectedRevision: draft.revision, ...(reason === 'previous-leader' ? { delivery: { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } } } : {}) }
    await expect(f.composerInput.send(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.drafts.get(draft.draftId)).toEqual(draft)
    expect((await f.service.detail(target)).inputs).toEqual([])
  })

  it('answers the current leader user question without an actor mention and replays the same receipt', async () => {
    const f = await fixture()
    await f.coordinator.send('root', { kind: 'question', audience: 'user', messageId: 'root-question-message', questionId: 'root-question', targetRunId: 'root', targetGeneration: 0, text: 'Choose a destination' })
    const draft = await f.drafts.open({ draftId: 'leader-answer', scope: { kind: 'conversation_branch', ...scope }, initialContent: createBuddyUserContent('Use the local directory'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null })
    const input = { ...scope, rootRunId: 'root', runId: 'root', draftId: draft.draftId, expectedRevision: draft.revision, delivery: { mode: 'current' as const, actorId: 'default', target: { rootRunId: 'root', runId: 'root' } } }
    const cleared = await f.composerInput.send(input)
    expect(cleared?.content).toEqual(createBuddyUserContent())
    expect(f.mailbox.findQuestion('root-question')).toMatchObject({ open: false, answer: { text: 'Use the local directory' } })
    expect(await f.composerInput.send(input)).toEqual(cleared)
    expect((await f.service.detail({ ...scope, rootRunId: 'root', runId: 'root' })).inputs).toHaveLength(1)
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
  })

  it('does not let an unmentioned answer target the previous leader after the task leader changes', async () => {
    const f = await fixture()
    await f.coordinator.send('root', { kind: 'question', audience: 'user', messageId: 'root-question-message', questionId: 'root-question', targetRunId: 'root', targetGeneration: 0, text: 'Choose a destination' })
    const draft = await f.drafts.open({ draftId: 'leader-answer', scope: { kind: 'conversation_branch', ...scope }, initialContent: createBuddyUserContent('Use the local directory'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null })
    f.conversations.setBuddy({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
    await expect(f.composerInput.send({ ...scope, rootRunId: 'root', runId: 'root', draftId: draft.draftId, expectedRevision: draft.revision, delivery: { mode: 'current', actorId: 'default', target: { rootRunId: 'root', runId: 'root' } } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.drafts.get(draft.draftId)).toEqual(draft)
    expect(f.mailbox.findQuestion('root-question')).toMatchObject({ open: true, answer: null })
  })

  it('rejects rich question answers and incompatible model settings without consuming the draft', async () => {
    const f = await inputFixture()
    await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'question-message', questionId: 'question', targetRunId: 'child', targetGeneration: 0, text: 'Choose a destination' })
    const delivery = { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } }
    const rich = await f.drafts.save({ draftId: f.draft.draftId, expectedRevision: f.draft.revision, content: { ...f.draft.content, panelResourceIds: ['attachment'] }, executionConfig: f.draft.executionConfig, modelSelection: null })
    await expect(f.composerInput.send({ ...f.input, expectedRevision: rich.revision, delivery })).rejects.toMatchObject({ code: 'INPUT_DELIVERY_INCOMPATIBLE' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(rich)
    const changedModel = await f.drafts.save({ draftId: rich.draftId, expectedRevision: rich.revision, content: f.draft.content, executionConfig: rich.executionConfig, modelSelection: { providerId: 'fixture', modelId: 'another', reasoning: null, serviceTier: null } })
    await expect(f.composerInput.send({ ...f.input, expectedRevision: changedModel.revision, delivery })).rejects.toMatchObject({ code: 'INPUT_DELIVERY_INCOMPATIBLE' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(changedModel)
    expect(f.mailbox.findQuestion('question')).toMatchObject({ open: true, answer: null })
    expect((await f.service.detail(target)).inputs).toEqual([])
  })

  it('keeps rich current input out of a pending question and queues next without answering or publishing it', async () => {
    const f = await inputFixture()
    await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'question-message', questionId: 'question', targetRunId: 'child', targetGeneration: 0, text: 'Choose a destination' })
    const queue = createChatQueueRepository(f.database)
    const prepared = {
      ...f.draft.executionConfig,
      buddyId: f.actor.id,
      branchId: 'branch',
      conversationId: 'conversation',
      createdAt: executionNow,
      draft: { draftId: f.draft.draftId, expectedRevision: f.draft.revision },
      attachmentBindings: [],
      model: 'fixture',
      provider: 'fixture',
      spaceId: null,
      title: null,
      requestId: 'queued-question',
      requestFingerprint: 'queued-question',
      runId: 'next-run',
      runInput: { attachmentIds: [], contextItems: [], prompt: 'Only after this work', reasoning: null, serviceTier: null },
      userMessageContent: { userContent: { ...f.draft.content, quotes: [{ id: 'quote', text: 'Goal', source: { ...scope, messageId: 'goal', role: 'user', runId: null } }] }, resourceSnapshots: [] },
      userMessageId: 'queued-input',
    }
    const delivery = { mode: 'current' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } }
    expect(() => queue.enqueue({ ...prepared, delivery })).toThrow(expect.objectContaining({ code: 'INPUT_DELIVERY_INCOMPATIBLE' }))
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    queue.enqueue({ ...prepared, delivery: { ...delivery, mode: 'next' } })
    expect(f.mailbox.findQuestion('question')).toMatchObject({ open: true, answer: null })
    expect((await f.service.detail(target)).inputs).toEqual([])
    expect(f.conversations.listBranchMessages('conversation', 'branch')).toHaveLength(1)
    expect(queue.list(scope)).toMatchObject([{ id: 'queued-input', delivery: { ...delivery, mode: 'next' }, state: 'waiting' }])
  })

  it('rejects next or null-target envelopes on the private current-input channel', async () => {
    const f = await inputFixture()
    for (const delivery of [
      { mode: 'next' as const, actorId: f.actor.id, target: { rootRunId: 'root', runId: 'child' } },
      { mode: 'current' as const, actorId: f.actor.id, target: null },
    ]) {
      await expect(f.composerInput.send({ ...f.input, delivery })).rejects.toMatchObject({ code: 'INPUT_DELIVERY_INCOMPATIBLE' })
    }
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    expect((await f.service.detail(target)).inputs).toEqual([])
  })

  it('answers a pending user question through the composer and safely replays its accepted input', async () => {
    const f = await inputFixture()
    await f.coordinator.send('child', { kind: 'question', audience: 'user', messageId: 'mailbox-question', questionId: 'actual-question', targetRunId: 'child', targetGeneration: 0, text: 'Choose a destination' })
    const failing = new ExecutionComposerInputService({
      ...f.inputOptions,
      delivery: {
        send: input => f.service.send(input),
        answer: async (input) => {
          await f.service.answer(input)
          throw new Error('Connection lost')
        },
      },
    })
    await expect(failing.send(f.input)).rejects.toThrow('Connection lost')
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    await f.service.cancel(target)
    const cleared = (await f.composerInput.send(f.input))!
    expect(cleared.content).toEqual(createBuddyUserContent())
    expect(f.mailbox.findQuestion('actual-question')).toMatchObject({ open: false, answer: { kind: 'answer', text: '@Reviewer Additional direction' } })
    expect((await f.service.detail(target)).inputs).toHaveLength(1)
  })

  it('falls through to a new turn when the recipient closes before or during delivery, without consuming the draft', async () => {
    for (const closedBeforeDelivery of [true, false]) {
      const f = await inputFixture()
      if (closedBeforeDelivery)
        await f.service.cancel(target)
      const delivery = new ExecutionComposerInputService({
        ...f.inputOptions,
        delivery: {
          answer: input => f.service.answer(input),
          send: async (input) => {
            if (!closedBeforeDelivery)
              await f.service.cancel(target)
            return f.service.send(input)
          },
        },
      })
      await expect(delivery.send(f.input)).resolves.toBeNull()
      expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
      expect((await f.service.detail(target)).inputs).toEqual([])
    }
  })

  it('rejects a different actor, private NPC, wrong branch and resource input without clearing the draft', async () => {
    const f = await inputFixture()
    f.executions.admitChild(f.child('npc'))
    const other = f.buddies.create({ name: 'Other' })
    f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: executionNow })
    f.executions.admitChild(f.child('other', other.id))
    for (const input of [{ ...f.input, runId: 'npc' }, { ...f.input, runId: 'other' }, { ...f.input, branchId: 'other' }])
      await expect(f.composerInput.send(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(f.draft)
    const rich = await f.drafts.save({ draftId: f.draft.draftId, expectedRevision: f.draft.revision, content: { ...f.draft.content, panelResourceIds: ['attachment'] }, executionConfig: f.draft.executionConfig, modelSelection: null })
    await expect(f.composerInput.send({ ...f.input, expectedRevision: rich.revision })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.drafts.get(f.draft.draftId)).toEqual(rich)
    expect((await f.service.detail(target)).inputs).toEqual([])
  })
})
