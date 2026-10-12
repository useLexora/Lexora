import type { ExecutionsChanged } from '../../../../../shared/executions/executionPresentationApi'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddiesService } from '../../../buddies/BuddiesService'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import { createExecutionStorageFixture, executionNow } from '../../../storage/__tests__/executionFixture'
import { createArtifactRepository } from '../../../storage/artifactRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { createUsageRepository } from '../../../storage/usageRepository'
import { UsageService } from '../../../usage/UsageService'
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
  cleanups.push(async () => {
    service.dispose()
    usageService.dispose()
    await coordinator.dispose()
    await lifecycle.dispose()
    await events.close()
    mutations.dispose()
    storage.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...storage, events, mailbox, mutations, coordinator, service, usageService }
}

const scope = { conversationId: 'conversation', branchId: 'branch' }
const target = { ...scope, rootRunId: 'root', runId: 'child' }

describe('execution presentation ownership', () => {
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

  it('attributes recorded usage to one execution without counting its caller, siblings or cache warming', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.admitChild(f.child('sibling'))
    for (const [runId, purpose, input] of [
      ['root', 'turn', 100],
      ['sibling', 'turn', 1000],
      ['child', 'cache_warm', 999],
      ['child', 'turn', 12],
      ['child', 'tool', 7],
    ] as const) {
      await f.usageService.record({
        runId,
        purpose,
        sourceEntryId: `${runId}-${purpose}`,
        createdAt: executionNow,
        model: 'fixture',
        provider: 'fixture',
        usage: { input, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: input + 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      })
    }
    const detail = await f.service.detail(target)
    expect(detail.execution).toMatchObject({ runId: 'child', parentRunId: 'root' })
    expect(detail.usage).toEqual({ inputTokens: 19, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2 })
    expect((await f.service.detail({ ...target, runId: 'root' })).usage?.inputTokens).toBe(100)
    expect((await f.service.detail({ ...target, runId: 'sibling' })).usage?.inputTokens).toBe(1000)
  })
  it('delivers a private user supplement once, retains receipts, and rejects stale or conflicting targets', async () => {
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
    f.conversations.createBranch({ id: 'other', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: executionNow, activate: true })
    await expect(f.service.send({ ...input, messageId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('stops the current children without cancelling their caller and retains closed records', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.admitChild(f.child('sibling'))
    await expect(f.service.cancelChildren({ ...target, runId: 'root' })).resolves.toEqual({ cancelledRunIds: ['child', 'sibling'] })
    expect(f.service.list(scope).filter(record => record.parentRunId === 'root')).toEqual([
      expect.objectContaining({ runId: 'child', status: 'cancelled', phase: 'closed', canSend: false }),
      expect.objectContaining({ runId: 'sibling', status: 'cancelled', phase: 'closed', canSend: false }),
    ])
    expect(f.executions.find('root')?.run.status).toBe('running')
    await expect(f.service.send({ ...target, messageId: '11111111-1111-4111-8111-111111111111', text: 'Late instruction' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
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
    expect(f.events.listForRuns(['child'], { latestActivityOnly: true })).toEqual([expect.objectContaining({ type: 'run.progress' })])
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
  it('allows cancellation while the caller closes without reopening its input channel', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    f.database.prepare('UPDATE execution_state SET phase = \'closing\' WHERE run_id = \'root\'').run()
    expect(f.service.list(scope).find(record => record.runId === 'child')).toMatchObject({ canCancel: true, canSend: false })
    await expect(f.service.cancelChildren({ ...target, runId: 'root' })).resolves.toEqual({ cancelledRunIds: ['child'] })
    expect(f.executions.find('child')?.run.status).toBe('cancelled')
    expect(f.executions.find('root')?.cancelRequestedAt).toBeNull()
  })
})
