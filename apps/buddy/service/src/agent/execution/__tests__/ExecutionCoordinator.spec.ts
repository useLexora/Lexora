import type { RunEventLogUnavailableError } from '../../../events/RunEventFailure'
import type { RunRecord } from '../../../storage/runRecord'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../../shared/buddies/buddySettings'
import { EXECUTION_MAILBOX_ENTRY_TYPE } from '../../../../../shared/executions/executionApi'
import { BuddyDefinitionResolver } from '../../../buddies/BuddyDefinitionResolver'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunEventCorruptionError, RunEventStorageError } from '../../../events/RunEventFailure'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import { createExecutionStorageFixture, executionNow } from '../../../storage/__tests__/executionFixture'
import { createConversationMemberRepository } from '../../../storage/conversationMemberRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { ExecutionCoordinator } from '../ExecutionCoordinator'
import { ExecutionDelegationService } from '../ExecutionDelegationService'
import { renderMailboxMessage } from '../executionMailboxEntries'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture(stopExecution: (runId: string) => Promise<boolean> = async () => false, hostShellSupervision = true) {
  const storage = createExecutionStorageFixture()
  const directory = await mkdtemp(join(tmpdir(), 'lexora-execution-'))
  const events = createRunEventLog({ database: storage.database, conversationsDirectory: directory })
  const mailbox = createMailboxRepository(storage.database)
  const lifecycle = new RunLifecycleService({ eventLog: events, repository: storage.runs })
  const mutations = new MutationCoordinator()
  const childDone = Promise.withResolvers<RunRecord>()
  const unavailable = new Map<string, RunEventLogUnavailableError>()
  const recovered: string[] = []
  const coordinator = new ExecutionCoordinator({
    hostShellSupervision,
    availability: { assertRunExecutable: (id) => {
      const error = unavailable.get(id)
      if (error)
        throw error
    } },
    recoverQuarantinedRun: (id) => {
      if (!(unavailable.get(id) instanceof RunEventCorruptionError))
        return false
      recovered.push(id)
      return storage.runs.reconcileQuarantined(id, executionNow)
    },
    executions: storage.executions,
    mailbox,
    events,
    lifecycle,
    mutations,
    readResult: (id) => {
      const error = unavailable.get(id)
      if (error)
        throw error
      return `Result from ${id}`
    },
    launchChild: async runId => ({ runId, completion: childDone.promise }),
    stopExecution,
    listIncomplete: () => storage.runs.listIncomplete(),
  })
  cleanups.push(async () => {
    childDone.resolve(storage.runs.findById('root')!)
    await coordinator.dispose()
    await lifecycle.dispose()
    await events.close()
    mutations.dispose()
    storage.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...storage, events, mailbox, lifecycle, mutations, coordinator, childDone, unavailable, recovered }
}

function delegationService(f: Awaited<ReturnType<typeof fixture>>) {
  const members = createConversationMemberRepository(f.database)
  const definitions = new BuddyDefinitionResolver({ buddies: f.buddies, members, providers: { getDefaultModel: async () => null, executionModels: { getServiceTiers: () => [], resolveAvailable: async () => {
    throw new Error('Unexpected model request')
  } } } })
  return new ExecutionDelegationService({ readResult: async () => '', readToolOptions: async () => [], buddies: f.buddies, members, definitions, executions: f.executions, mailbox: f.mailbox, coordinator: f.coordinator, stopExecution: async () => false })
}

describe('execution coordination', () => {
  it('closes a quarantined child only after its owner stops while healthy siblings and the root settle normally', async () => {
    const stopped = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = await fixture(async (id) => {
      if (id === 'broken') {
        entered.resolve()
        await stopped.promise
        return true
      }
      if (id === 'root') {
        await f.coordinator.finalize({ runId: id, cleanup: 'completed', outcome: { status: 'cancelled', errorCode: 'RUN_CANCELLED' } })
        return true
      }
      return false
    })
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('broken'))
    f.executions.admitChild(f.child('healthy'))
    await f.coordinator.begin('broken', signal)
    const lease = await f.mutations.acquire({ runId: 'broken', invocationId: 'active', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    f.unavailable.set('broken', new RunEventCorruptionError('broken'))
    const cancelling = f.coordinator.cancel('root', 'RUN_CANCELLED', async (id) => {
      if (id === 'broken') {
        entered.resolve()
        await stopped.promise
        return true
      }
      return id === 'root'
    })
    try {
      await entered.promise
      expect(f.recovered).toEqual([])
      expect(f.executions.find('broken')).toMatchObject({ phase: 'working', cleanupState: 'pending' })
      expect(f.executions.find('root')?.phase).not.toBe('closed')
      lease.markHazard('FILE_RESULT_UNKNOWN')
      stopped.resolve()
      await cancelling
      expect(f.executions.find('broken')).toMatchObject({ phase: 'closed', cleanupState: 'degraded', run: { status: 'failed', errorCode: 'EVENT_LOG_CORRUPTED' } })
      expect(f.executions.find('healthy')).toMatchObject({ phase: 'closed', run: { status: 'cancelled' } })
      expect(f.executions.find('root')).toMatchObject({ phase: 'closed', cleanupState: 'degraded', run: { status: 'cancelled' } })
      expect(await f.events.read('broken')).toEqual([])
      expect(f.mailbox.listUnconsumed('root').some(message => message.sourceRunId === 'broken')).toBe(false)
      expect(f.mutations.getRunState('broken').hazards).toHaveLength(1)
      f.runs.create({ id: 'new-root', buddyId: 'default', actorSnapshot: f.snapshot('default'), branchId: 'branch', conversationId: 'conversation', triggeringMessageId: 'new-goal', provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, startedAt: executionNow, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
      await f.coordinator.begin('new-root', signal)
      expect(f.executions.find('new-root')?.phase).toBe('working')
    }
    finally {
      lease.release()
      stopped.resolve()
      await cancelling
    }
  })

  it('does not close a quarantined root before its child and its actual mutation settle', async () => {
    const childStopped = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = await fixture(async (id) => {
      if (id === 'child') {
        entered.resolve()
        await childStopped.promise
      }
      return false
    })
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('child'))
    const lease = await f.mutations.acquire({ runId: 'root', invocationId: 'active', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    f.unavailable.set('root', new RunEventCorruptionError('root'))
    const finalizing = f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'failed', errorCode: 'EVENT_LOG_CORRUPTED' } })
    try {
      await entered.promise
      expect(f.recovered).toEqual([])
      childStopped.resolve()
      await vi.waitFor(() => expect(f.executions.find('child')?.phase).toBe('closed'))
      expect(f.recovered).toEqual([])
      expect(f.executions.find('root')?.phase).not.toBe('closed')
      lease.release()
      expect(await finalizing).toMatchObject({ status: 'failed', errorCode: 'EVENT_LOG_CORRUPTED' })
      expect(f.executions.find('root')).toMatchObject({ phase: 'closed', cleanupState: 'degraded' })
      expect(await f.events.read('root')).toEqual([])
      expect(f.database.prepare('SELECT count(*) AS count FROM execution_mailbox_receipts WHERE kind = \'consumed\'').get()).toEqual({ count: 0 })
    }
    finally {
      lease.release()
      childStopped.resolve()
      await finalizing
    }
  })

  it('does not turn a shared storage failure into quarantined cleanup', async () => {
    const f = await fixture()
    const failure = new RunEventStorageError({ runId: 'root', firstSequence: null, lastSequence: null }, 'read', 'read', 'unknown')
    f.unavailable.set('root', failure)
    try {
      await expect(f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'failed', errorCode: 'EVENT_STORAGE_FAILED' } })).rejects.toBe(failure)
      await expect(f.coordinator.cancel('root', 'RUN_CANCELLED', async () => false)).rejects.toMatchObject({ errors: [failure] })
      expect(f.recovered).toEqual([])
      expect(f.executions.find('root')?.phase).not.toBe('closed')
    }
    finally { f.unavailable.clear() }
  })

  it('reports a wait tool deadline while preserving real mutation and execution state', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('queued'))
    const lease = await f.mutations.acquire({ runId: 'root', invocationId: 'active', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    const service = delegationService(f)
    const caller = { run: { runId: 'root', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }, getPermissions: () => ({ approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }) }
    try {
      expect(await service.execute(caller, 'deadline', { operation: 'wait', timeoutMs: 10 }, signal)).toMatchObject({
        waitStatus: 'timedout',
        phase: 'working',
        status: 'running',
        cleanup: 'pending',
        children: [{ runId: 'queued', phase: 'queued' }],
      })
      expect(f.mutations.getRunState('root')).toEqual({ active: 1, pending: 0, hazards: [] })
    }
    finally { lease.release() }
  })

  it('retains progress receipts without waking a parent until an actionable message arrives', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const parent = await f.coordinator.begin('root', signal)
    await f.coordinator.admitChild(f.child('child'))
    await f.coordinator.begin('child', signal)
    const progress = { messageId: 'progress', targetRunId: 'root', targetGeneration: 0, kind: 'supplement' as const, purpose: 'progress' as const, text: 'Partial finding' }
    await f.coordinator.send('child', progress)
    await expect(f.coordinator.send('child', { ...progress, purpose: undefined })).rejects.toMatchObject({ code: 'conflict' })
    await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
    const pending = await parent.readPending()
    expect(pending.shouldResume).toBe(false)
    expect(pending.messages).toHaveLength(1)
    expect(f.executions.find('root')?.phase).toBe('waiting')
    const receipt = { sourceRunId: 'child', messageId: 'progress', payloadHash: pending.messages[0]!.payloadHash, contextEntryId: 'durable-entry' }
    await parent.acceptInContext([receipt])
    expect(f.mailbox.find('progress')?.receipt).toEqual(receipt)
    let resumed = false
    const waiting = f.coordinator.wait('root', ['child'], 10000, signal).then(() => {
      resumed = true
    })
    await vi.waitFor(() => expect(f.executions.find('root')?.phase).toBe('waiting'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(resumed).toBe(false)
    await f.coordinator.send('child', { messageId: 'question', targetRunId: 'root', targetGeneration: 0, kind: 'question', questionId: 'blocking-question', audience: 'caller', text: 'Which scope?' })
    await waiting
    expect((await parent.readPending()).shouldResume).toBe(true)
    expect((await parent.readPending()).messages.map(message => message.messageId)).toEqual(['progress', 'question'])
  })

  it('admits the sixth accepted NPC when a working sibling waits and rechecks the resumed permit', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    for (let index = 1; index <= 6; index++)
      await f.coordinator.admitChild(f.child(`npc-${index}`))
    for (let index = 1; index <= 5; index++)
      await f.coordinator.begin(`npc-${index}`, signal)
    const sixth = f.coordinator.begin('npc-6', signal)
    expect(f.executions.find('npc-6')?.phase).toBe('queued')
    expect(f.executions.listTree('root').filter(item => item.run.executionKind === 'npc_child' && item.phase === 'working')).toHaveLength(5)
    const waitingSignal = new AbortController()
    const waiting = f.coordinator.wait('npc-1', [], 10000, waitingSignal.signal).catch(error => error)
    await sixth
    expect(f.executions.find('npc-1')?.phase).toBe('waiting')
    expect(f.executions.find('npc-6')?.phase).toBe('working')
    waitingSignal.abort()
    expect(await waiting).toBeInstanceOf(DOMException)
    const resumeSignal = new AbortController()
    const resume = f.coordinator.begin('npc-1', resumeSignal.signal).catch(error => error)
    expect(f.executions.find('npc-1')?.phase).toBe('waiting')
    resumeSignal.abort()
    expect(await resume).toBeInstanceOf(DOMException)
    expect(f.executions.listTree('root').filter(item => item.run.executionKind === 'npc_child' && item.phase === 'working')).toHaveLength(5)
  })

  it('lets separate supporting actors wait while each of their own NPCs starts', async () => {
    const f = await fixture()
    const other = f.buddies.create({ name: 'Second supporting actor' })
    f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: executionNow })
    f.buddies.update({ buddyId: other.id, expectedRevision: other.revision, settings: buddySettingsSchema.parse({ ...other.settings, npcIds: [f.npc.id] }) })
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    await f.coordinator.admitChild(f.child('actor-a', f.actor.id))
    await f.coordinator.admitChild(f.child('actor-b', other.id))
    await Promise.all(['actor-a', 'actor-b'].map(id => f.coordinator.begin(id, signal)))
    await f.coordinator.admitChild(f.child('npc-a', f.npc.id, 'actor-a'))
    await f.coordinator.admitChild(f.child('npc-b', f.npc.id, 'actor-b'))
    const waitingSignal = new AbortController()
    const waiters = [
      f.coordinator.wait('actor-a', ['npc-a'], 10000, waitingSignal.signal).catch(error => error),
      f.coordinator.wait('actor-b', ['npc-b'], 10000, waitingSignal.signal).catch(error => error),
    ]
    await Promise.all(['npc-a', 'npc-b'].map(id => f.coordinator.begin(id, signal)))
    expect(['actor-a', 'actor-b'].map(id => f.executions.find(id)?.phase)).toEqual(['waiting', 'waiting'])
    expect(['npc-a', 'npc-b'].map(id => f.executions.find(id)?.phase)).toEqual(['working', 'working'])
    expect(['npc-a', 'npc-b'].map(id => f.executions.find(id)?.run.parentRunId)).toEqual(['actor-a', 'actor-b'])
    waitingSignal.abort()
    expect(await Promise.all(waiters)).toEqual([expect.any(DOMException), expect.any(DOMException)])
  })

  it('keeps unsupported shell execution exclusive with child admission', async () => {
    const ordinary = await fixture(undefined, false)
    await ordinary.coordinator.begin('root', new AbortController().signal)
    ordinary.coordinator.assertShellExecutionAllowed('root')
    await expect(ordinary.coordinator.admitChild(ordinary.child('child'))).rejects.toMatchObject({ code: 'SHELL_SUPERVISION_UNAVAILABLE' })
    expect(ordinary.executions.listTree('root')).toHaveLength(1)
    expect(ordinary.mutations.getRunState('root').hazards).toEqual([])

    const tree = await fixture(undefined, false)
    await tree.coordinator.begin('root', new AbortController().signal)
    await tree.coordinator.admitChild(tree.child('child'))
    expect(() => tree.coordinator.assertShellExecutionAllowed('root')).toThrow(expect.objectContaining({ code: 'SHELL_SUPERVISION_UNAVAILABLE' }))
    expect(() => tree.coordinator.assertShellExecutionAllowed('child')).toThrow(expect.objectContaining({ code: 'SHELL_SUPERVISION_UNAVAILABLE' }))
    expect(tree.executions.find('child')?.phase).toBe('queued')
  })

  it('waits for the child result and durable consumption before sealing the parent', async () => {
    const f = await fixture()
    const parent = await f.coordinator.begin('root', new AbortController().signal)
    await f.coordinator.admitChild(f.child('child'))
    const waiting = await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
    expect(waiting.kind).toBe('pending')
    expect(f.executions.find('root')?.phase).toBe('waiting')
    const child = await f.coordinator.begin('child', new AbortController().signal)
    await f.lifecycle.start({ runId: 'child', expectedPurposes: ['chat'], startedAt: new Date().toISOString(), payload: {} })
    const closing = await child.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
    expect(closing.kind).toBe('sealed')
    const settled = await f.coordinator.finalize({ runId: 'child', cleanup: 'completed', outcome: { status: 'completed' } })
    f.childDone.resolve(settled)
    const pending = await parent.readPending()
    expect(pending.messages).toHaveLength(1)
    expect(pending.messages[0]).toMatchObject({ sourceRunId: 'child', targetRunId: 'root', kind: 'result', text: 'Result from child' })
    const message = pending.messages[0]!
    const receipt = { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: 'durable-parent-context' }
    await parent.acceptInContext([receipt])
    expect(f.mailbox.find(message.messageId)?.state).toBe('accepted')
    expect((await parent.readPending()).messages).toHaveLength(1)
    const sealed = await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })
    expect(sealed.kind).toBe('sealed')
    expect(f.mailbox.find(message.messageId)?.state).toBe('consumed')
    expect(f.executions.find('root')?.phase).toBe('closing')
    await f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'completed' } })
    expect(f.runs.findById('root')?.status).toBe('completed')
    const childEvents = await f.events.read('child')
    expect(childEvents.slice(-2).map(event => event.type)).toEqual(['execution.mailbox.sent', 'run.completed'])
  })

  it('does not lose an event between reading a revision and subscribing to wait', async () => {
    const f = await fixture()
    const port = await f.coordinator.begin('root', new AbortController().signal)
    const snapshot = await port.readPending()
    await f.events.append({ runId: 'root', type: 'run.progress', payload: {} })
    await port.waitForChange({ afterRevision: snapshot.revision })
  })

  it('waits for the named child despite an earlier result and answers a caller question without a lost wakeup', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('earlier'))
    f.executions.admitChild(f.child('pending'))
    await f.coordinator.failBeforeStart('earlier', new Error('Earlier result'))
    const child = await f.coordinator.begin('pending', signal)
    const waiting = f.coordinator.wait('root', ['pending'], 10000, signal)
    await vi.waitFor(() => expect(f.executions.find('root')?.phase).toBe('waiting'))
    await f.coordinator.send('pending', { messageId: 'caller-question', questionId: 'caller-question', kind: 'question', audience: 'caller', targetRunId: 'root', targetGeneration: 0, text: 'Which dataset?' })
    await waiting
    expect(f.executions.find('root')?.phase).toBe('working')
    await f.coordinator.wait('root', ['pending'], 10000, signal)
    await f.coordinator.answerQuestion('root', 'caller-question', 'Dataset C')
    await f.coordinator.wait('pending', [], 10000, signal)
    const answer = (await child.readPending()).messages[0]!
    expect(answer).toMatchObject({ kind: 'answer', questionId: 'caller-question', targetRunId: 'pending', text: 'Dataset C' })
    const receipt = { sourceRunId: answer.sourceRunId, messageId: answer.messageId, payloadHash: answer.payloadHash, contextEntryId: 'child-answer' }
    await child.acceptInContext([receipt])
    expect((await child.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })).kind).toBe('sealed')
    expect(f.mailbox.findQuestion('caller-question')?.open).toBe(false)
    expect(f.database.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(0)
  })

  it('waits for new child work when an earlier result is journaled but not yet consumed', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('earlier'))
    f.executions.admitChild(f.child('pending'))
    await f.coordinator.failBeforeStart('earlier', new Error('Earlier result'))
    const message = f.mailbox.listUnconsumed('root')[0]!
    const journal = SessionManager.inMemory()
    journal.appendCustomEntry('lexora.conversation.checkpoint.v1', { runId: 'root', branchId: 'branch', position: 'before' })
    journal.appendCustomMessageEntry(EXECUTION_MAILBOX_ENTRY_TYPE, renderMailboxMessage(message), false, message)
    const service = delegationService(f)
    expect(service.status('root', 'root', journal.getBranch()).updates).toEqual([])
    expect(f.mailbox.find(message.messageId)?.state).toBe('pending')
    const caller = { run: { runId: 'root', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }, getPermissions: () => ({ approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }) }
    const waiting = service.execute(caller, 'new-result', { operation: 'wait', timeoutMs: 10000 }, signal, journal.getBranch())
    await vi.waitFor(() => expect(f.executions.find('root')?.phase).toBe('waiting'))
    await f.coordinator.failBeforeStart('pending', new Error('New result'))
    await expect(waiting).resolves.toMatchObject({ updates: [{ sourceRunId: 'pending', kind: 'result' }] })
    expect(f.mailbox.find(message.messageId)?.state).toBe('pending')
    expect(f.mailbox.find(message.messageId)?.receipt).toBeNull()
  })

  it('waits past consumed children by default while preserving unread results and explicit completed targets', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const parent = await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('earlier'))
    f.executions.admitChild(f.child('pending'))
    await f.coordinator.failBeforeStart('earlier', new Error('Earlier result'))
    const service = delegationService(f)
    const caller = { run: { runId: 'root', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }, getPermissions: () => ({ approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }) }
    const unread = await service.execute(caller, 'unread', { operation: 'wait', timeoutMs: 10000 }, signal)
    expect(unread).toMatchObject({ updates: [{ sourceRunId: 'earlier', kind: 'result' }] })
    const message = (await parent.readPending()).messages[0]!
    const receipt = { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: 'earlier-result' }
    await parent.acceptInContext([receipt])
    expect((await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })).kind).toBe('pending')
    await f.coordinator.begin('root', signal)
    const waiting = service.execute(caller, 'next', { operation: 'wait', timeoutMs: 10000 }, signal)
    await vi.waitFor(() => expect(f.executions.find('root')?.phase).toBe('waiting'))
    await f.coordinator.failBeforeStart('pending', new Error('New result'))
    expect(await waiting).toMatchObject({ updates: [{ sourceRunId: 'pending', kind: 'result' }] })
    await expect(service.execute(caller, 'explicit', { operation: 'wait', runId: 'earlier', timeoutMs: 10000 }, signal)).resolves.toMatchObject({ runId: 'earlier', phase: 'closed' })
  })

  it('requires a question recipient and waits for a human answer without polling an empty child list', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('actor', f.actor.id))
    await f.coordinator.begin('actor', signal)
    const service = delegationService(f)
    const caller = { run: { runId: 'actor', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }, getPermissions: () => ({ approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }) }
    await expect(service.execute(caller, 'missing-recipient', { operation: 'question', text: 'Choose a color' }, signal)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ['audience'] })] })
    expect(f.mailbox.listQuestions('actor')).toEqual([])
    const question = await service.execute(caller, 'question', { operation: 'question', audience: 'user', text: 'Choose a color' }, signal) as { questionId: string }
    const waiting = service.execute(caller, 'wait', { operation: 'wait', timeoutMs: 10000 }, signal)
    await vi.waitFor(() => expect(f.executions.find('actor')?.phase).toBe('waiting'))
    expect(f.mailbox.findQuestion(question.questionId)?.open).toBe(true)
    await f.coordinator.answerQuestion(null, question.questionId, 'blue')
    expect(await waiting).toMatchObject({ updates: [expect.objectContaining({ kind: 'answer', questionId: question.questionId, text: 'blue' })] })
    expect(f.executions.find('actor')?.phase).toBe('working')
  })

  it.each(['timeout', 'cancel'] as const)('ends only the wait on %s while a real mutation and working permit remain owned', async (reason) => {
    const f = await fixture()
    const controller = new AbortController()
    await f.coordinator.begin('root', controller.signal)
    const lease = await f.mutations.acquire({ runId: 'root', invocationId: 'active', lifetime: 'runtime', claims: [{ kind: 'host' }], signal: controller.signal })
    let completed = false
    const overlapping = f.mutations.acquire({ runId: 'later', invocationId: 'later', lifetime: 'runtime', claims: [{ kind: 'host' }], signal: new AbortController().signal }).then((next) => {
      completed = true
      next.release()
    })
    try {
      const waiting = f.coordinator.wait('root', [], reason === 'timeout' ? 10 : 10000, controller.signal)
      if (reason === 'cancel') {
        const cancelled = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
        controller.abort()
        await cancelled
      }
      else {
        expect(await waiting).toBe('timedout')
      }
      expect(f.executions.find('root')).toMatchObject({ phase: 'working', cleanupState: 'pending' })
      expect(f.mutations.getRunState('root')).toEqual({ pending: 0, active: 1, hazards: [] })
      expect(f.mutations.getRunState('later')).toMatchObject({ pending: 1, active: 0 })
      expect(completed).toBe(false)
    }
    finally {
      lease.release()
      await overlapping
    }
    expect(completed).toBe(true)
  })

  it('admits a child after a historical unknown without clearing its evidence', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    const lease = await f.mutations.acquire({ runId: 'root', invocationId: 'old', lifetime: 'external', claims: [{ kind: 'host' }], signal })
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: 'unknown-process', settlement: 'unknown' })
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    const child = await f.coordinator.admitChild(f.child('after-unknown'))
    expect(child.run.id).toBe('after-unknown')
    expect(f.mutations.getHazards()).toHaveLength(1)
    expect(f.mutations.getOwnedProcesses('old')).toEqual([{ processId: 'unknown-process', settlement: 'unknown' }])
  })

  it('reclaims the working permit when a wait reaches its deadline', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    const waiting = f.coordinator.wait('root', [], 30, signal)
    await vi.waitFor(() => expect(f.executions.find('root')?.phase).toBe('waiting'), { interval: 1 })
    await waiting
    expect(f.executions.find('root')?.phase).toBe('working')
    expect(f.mailbox.listUnconsumed('root')).toEqual([])
  })

  it('serializes supplementary input against successful close with an explicit acceptance result', async () => {
    for (const supplementFirst of [true, false]) {
      const f = await fixture()
      const parent = await f.coordinator.begin('root', new AbortController().signal)
      const send = () => f.coordinator.send('root', { messageId: 'supplement', targetRunId: 'root', targetGeneration: 0, kind: 'supplement', text: 'Use the updated target' })
      const close = () => parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
      const results = await Promise.allSettled(supplementFirst ? [send(), close()] : [close(), send()])
      const sent = results[supplementFirst ? 0 : 1]!
      const closing = results[supplementFirst ? 1 : 0]!
      if (sent.status === 'fulfilled') {
        expect(closing).toMatchObject({ status: 'fulfilled', value: { kind: 'pending' } })
        const message = (await parent.readPending()).messages[0]!
        const receipt = { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: 'supplement-context' }
        await parent.acceptInContext([receipt])
        expect((await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })).kind).toBe('sealed')
        expect(f.mailbox.find('supplement')?.state).toBe('consumed')
      }
      else {
        expect(sent.reason).toMatchObject({ code: 'stale' })
        expect(closing).toMatchObject({ status: 'fulfilled', value: { kind: 'sealed' } })
        expect(f.mailbox.find('supplement')).toBeNull()
      }
    }
  })

  it('retains the final child result when it races with parent close', async () => {
    for (const childFirst of [true, false]) {
      const f = await fixture()
      const parent = await f.coordinator.begin('root', new AbortController().signal)
      f.executions.admitChild(f.child('last-child'))
      const finishChild = () => f.coordinator.failBeforeStart('last-child', new Error('Child failed'))
      const closeParent = () => parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
      const [first, second] = await Promise.all(childFirst ? [finishChild(), closeParent()] : [closeParent(), finishChild()])
      expect(childFirst ? second : first).toMatchObject({ kind: 'pending' })
      const pending = await parent.readPending()
      expect(pending.messages).toHaveLength(1)
      const message = pending.messages[0]!
      expect(message).toMatchObject({ sourceRunId: 'last-child', targetRunId: 'root', kind: 'result' })
      const receipt = { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: 'last-result' }
      await parent.acceptInContext([receipt])
      expect((await parent.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })).kind).toBe('sealed')
      expect(f.mailbox.find(message.messageId)?.state).toBe('consumed')
      expect((await f.events.read('last-child')).filter(event => event.type === 'execution.mailbox.sent')).toHaveLength(1)
    }
  })

  it('records cancellation before aborting asynchronous preparation and never starts the queued child', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    const preparation = f.coordinator.prepare('child')
    const cancellation = f.coordinator.cancel('child', 'RUN_CANCELLED', async () => false)
    await vi.waitFor(() => expect(preparation.signal.aborted).toBe(true))
    expect(f.executions.find('child')?.cancelRequestedAt).not.toBeNull()
    await f.coordinator.failBeforeStart('child', new DOMException('Cancelled', 'AbortError'))
    preparation.release()
    expect(await cancellation).toBe(true)
    expect(f.runs.findById('child')?.status).toBe('cancelled')
    await expect(f.coordinator.begin('child', new AbortController().signal)).rejects.toMatchObject({ code: 'stale' })
  })

  it('keeps owned process hazards as degraded cleanup without blocking new mutations', async () => {
    const f = await fixture()
    const lease = await f.mutations.acquire({ lifetime: 'runtime' as const, runId: 'root', invocationId: 'writer', claims: [{ kind: 'tree', canonicalPath: '/workspace/a' }], signal: new AbortController().signal })
    lease.markHazard('PROCESS_CLEANUP_UNKNOWN')
    const port = await f.coordinator.begin('root', new AbortController().signal)
    await port.prepareClose({ outcome: { status: 'failed', errorCode: 'TOOL_FAILED' }, consumedReceipts: [] })
    await f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'failed', errorCode: 'TOOL_FAILED' } })
    expect(f.executions.find('root')).toMatchObject({ phase: 'closed', cleanupState: 'degraded' })
    const next = await f.mutations.acquire({ lifetime: 'runtime' as const, runId: 'later', invocationId: 'next', claims: [{ kind: 'file', canonicalPath: '/workspace/a/result' }], signal: new AbortController().signal })
    next.release()
    expect(f.mutations.getHazards()).toHaveLength(1)
    const safe = await f.mutations.acquire({ lifetime: 'runtime' as const, runId: 'later', invocationId: 'safe', claims: [{ kind: 'file', canonicalPath: '/workspace/b/result' }], signal: new AbortController().signal })
    safe.release()
  })

  it('seals failed parent admission before waiting for child cleanup', async () => {
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      stopping.resolve()
      await stopped.promise
      return false
    })
    f.executions.admitChild(f.child('child'))
    const parent = await f.coordinator.begin('root', new AbortController().signal)
    const child = await f.coordinator.begin('child', new AbortController().signal)
    const closing = parent.prepareClose({ outcome: { status: 'failed', errorCode: 'AGENT_RUN_FAILED' }, consumedReceipts: [] })
    await stopping.promise
    expect(f.executions.find('root')?.phase).toBe('closing')
    await expect(f.coordinator.admitChild(f.child('too-late'))).rejects.toMatchObject({ code: 'stale' })
    await expect(child.readPending()).rejects.toBeInstanceOf(Error)
    stopped.resolve()
    expect((await closing).kind).toBe('sealed')
    expect(f.runs.findById('child')?.status).toBe('cancelled')
  })

  it('aggregates child cleanup failures when the root settles', async () => {
    const f = await fixture()
    f.executions.admitChild(f.child('child'))
    await f.coordinator.failBeforeStart('child', new Error('Unavailable'))
    f.executions.recordCleanup('child', 'degraded', 'EXECUTION_CLEANUP_DEGRADED')
    await f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'failed', errorCode: 'AGENT_RUN_FAILED' } })
    expect(f.executions.find('root')?.cleanupState).toBe('degraded')
    expect(f.executions.find('child')?.cleanupState).toBe('degraded')
  })

  it('waits for a private user answer without consuming the ordinary chat queue', async () => {
    const f = await fixture()
    const port = await f.coordinator.begin('root', new AbortController().signal)
    await f.coordinator.send('root', { messageId: 'question', questionId: 'question', kind: 'question', audience: 'user', targetRunId: 'root', targetGeneration: 0, text: 'Choose the destination' })
    expect((await port.readPending()).messages).toEqual([])
    expect((await port.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })).kind).toBe('pending')
    expect(f.mailbox.findQuestion('question')).toMatchObject({ open: true, answer: null })
    await expect(f.coordinator.answerQuestion('root', 'question', 'Private destination')).rejects.toMatchObject({ code: 'unauthorized' })
    await f.coordinator.answerQuestion(null, 'question', 'Private destination')
    await f.coordinator.answerQuestion(null, 'question', 'Private destination')
    const pending = await port.readPending()
    expect(pending.messages).toHaveLength(1)
    const answer = pending.messages[0]!
    expect(answer).toMatchObject({ kind: 'answer', targetRunId: 'root', text: 'Private destination' })
    const receipt = { sourceRunId: answer.sourceRunId, messageId: answer.messageId, payloadHash: answer.payloadHash, contextEntryId: 'private-answer-context' }
    await port.acceptInContext([receipt])
    expect((await port.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [receipt] })).kind).toBe('sealed')
    expect(f.database.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(0)
    expect(f.mailbox.findQuestion('question')).toMatchObject({ open: false })
  })

  it('rejects a late answer after cancellation instead of reviving the execution', async () => {
    const f = await fixture()
    await f.coordinator.send('root', { messageId: 'question', questionId: 'question', kind: 'question', audience: 'user', targetRunId: 'root', targetGeneration: 0, text: 'Choose' })
    f.executions.requestCancel('root', new Date().toISOString())
    await expect(f.coordinator.answerQuestion(null, 'question', 'Too late')).rejects.toMatchObject({ code: 'stale' })
    expect(f.mailbox.findQuestion('question')).toMatchObject({ open: false, answer: null })
    expect(f.mailbox.listUnconsumed('root')).toEqual([])
  })
})
