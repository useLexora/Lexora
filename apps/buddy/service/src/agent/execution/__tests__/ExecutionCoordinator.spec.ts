import type { RunRecord } from '../../../storage/runRecord'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../../shared/buddies/buddySettings'
import { BuddyDefinitionResolver } from '../../../buddies/BuddyDefinitionResolver'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import { createExecutionStorageFixture, executionNow } from '../../../storage/__tests__/executionFixture'
import { createConversationMemberRepository } from '../../../storage/conversationMemberRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { ExecutionCoordinator } from '../ExecutionCoordinator'
import { ExecutionDelegationService } from '../ExecutionDelegationService'

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
  const coordinator = new ExecutionCoordinator({
    hostShellSupervision,
    executions: storage.executions,
    mailbox,
    events,
    lifecycle,
    mutations,
    readResult: id => `Result from ${id}`,
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
  return { ...storage, events, mailbox, lifecycle, mutations, coordinator, childDone }
}

describe('execution coordination', () => {
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

  it('starts more than five NPCs under the captured unlimited configuration', async () => {
    const f = await fixture()
    const snapshot = f.snapshot('default')
    snapshot.settings.npcConcurrency = { mode: 'unlimited' }
    f.database.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), 'root')
    const signal = new AbortController().signal
    await f.coordinator.begin('root', signal)
    for (let index = 0; index < 8; index++)
      await f.coordinator.admitChild(f.child(`npc-${index}`))
    await Promise.all(Array.from({ length: 8 }, (_, index) => f.coordinator.begin(`npc-${index}`, signal)))
    expect(f.executions.listTree('root').filter(item => item.run.executionKind === 'npc_child' && item.phase === 'working')).toHaveLength(8)
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
    const closed = await port.prepareClose({ outcome: { status: 'completed' }, consumedReceipts: [] })
    expect(closed.kind).toBe('sealed')
    await expect(f.coordinator.send('root', { messageId: 'late', targetRunId: 'root', targetGeneration: 0, kind: 'supplement', text: 'Late message' })).rejects.toMatchObject({ code: 'stale' })
    expect(f.mailbox.find('late')).toBeNull()
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

  it('waits past consumed children by default while preserving unread results and explicit completed targets', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const parent = await f.coordinator.begin('root', signal)
    f.executions.admitChild(f.child('earlier'))
    f.executions.admitChild(f.child('pending'))
    await f.coordinator.failBeforeStart('earlier', new Error('Earlier result'))
    const members = createConversationMemberRepository(f.database)
    const definitions = new BuddyDefinitionResolver({ buddies: f.buddies, members, providers: { getDefaultModel: async () => null, executionModels: { getServiceTiers: () => [], resolveAvailable: async () => {
      throw new Error('Unexpected model request')
    } } } })
    const service = new ExecutionDelegationService({ readToolOptions: async () => [], buddies: f.buddies, members, definitions, executions: f.executions, mailbox: f.mailbox, coordinator: f.coordinator, stopExecution: async () => false })
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
        expect(sent.value).toBeUndefined()
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

  it('keeps owned process hazards as degraded cleanup without blocking unrelated resources', async () => {
    const f = await fixture()
    const lease = await f.mutations.acquire({ lifetime: 'runtime' as const, runId: 'root', invocationId: 'writer', claims: [{ kind: 'tree', canonicalPath: '/workspace/a' }], signal: new AbortController().signal })
    lease.markHazard('PROCESS_CLEANUP_UNKNOWN')
    const port = await f.coordinator.begin('root', new AbortController().signal)
    await port.prepareClose({ outcome: { status: 'failed', errorCode: 'TOOL_FAILED' }, consumedReceipts: [] })
    await f.coordinator.finalize({ runId: 'root', cleanup: 'completed', outcome: { status: 'failed', errorCode: 'TOOL_FAILED' } })
    expect(f.executions.find('root')).toMatchObject({ phase: 'closed', cleanupState: 'degraded' })
    await expect(f.mutations.acquire({ lifetime: 'runtime' as const, runId: 'later', invocationId: 'unsafe', claims: [{ kind: 'file', canonicalPath: '/workspace/a/result' }], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MUTATION_RESOURCE_UNSAFE' })
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
