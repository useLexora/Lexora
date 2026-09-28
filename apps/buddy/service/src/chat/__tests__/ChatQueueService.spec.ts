import type { DatabaseSync } from 'node:sqlite'
import type { BuddyInputReferenceV1 } from '../../agent/context/BuddyInputReference'
import type { ExecutionSettled } from '../../agent/execution/ActiveRunRegistry'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { RunEventObservation } from '../../events/RunEventPorts'
import type { PrepareTurnRequestInput } from '../../storage/turnRequestRepository'
import type { ChatQueueChange, ChatQueueServiceOptions } from '../ChatQueueService'
import type { TurnRequestCommit } from '../TurnRequestService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { Emitter } from '../../../../shared/events/Emitter'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createTurnRequestRepository } from '../../storage/turnRequestRepository'
import { ChatQueueService } from '../ChatQueueService'
import { QueueContinuation } from '../QueueContinuation'
import { TurnRequestService } from '../TurnRequestService'

const fixtures: Array<{ database: DatabaseSync, service: ChatQueueService, continuation: QueueContinuation }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const stopped = fixture.continuation.dispose()
    fixture.service.dispose()
    await stopped
    await fixture.service.drain()
    fixture.database.close()
  }
})

describe('persistent chat queue scheduling', () => {
  it('commits queue and message ownership separately and consumes a queued draft only once', async () => {
    const f = fixture()
    const attachments = createAttachmentRepository(f.database)
    attachments.create({ id: 'owned-attachment', conversationId: null, draftId: 'draft', messageId: null, name: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 1, storedPath: '/private/source.txt', createdAt: '2026-09-15T00:00:00.000Z' })
    const prepared = f.input('A')
    prepared.runInput.attachmentIds = ['owned-attachment']
    const binding = { id: 'owned-attachment', sourceAttachmentId: 'owned-attachment', sourceDraftId: 'draft', messageId: prepared.userMessageId, storedPath: '/private/destination.txt', sourceStoredPath: '/private/source.txt', name: 'fixture.txt', sizeBytes: 1, mimeType: 'text/plain', createdAt: prepared.createdAt }
    prepared.attachmentBindings = [binding]
    f.turns.prepareStart = async () => ({ prepared, stagedAttachments: { validate: () => {}, bindings: [binding], commit: async () => {}, rollback: async () => {} } })
    const events: ChatQueueChange[] = []
    f.service.onDidChange(event => events.push(event))
    const input = { requestId: prepared.requestId, draftId: 'draft', expectedRevision: prepared.draft.expectedRevision }
    await f.service.enqueue(input)
    await f.service.enqueue(input)
    expect(events).toHaveLength(1)
    expect(events[0]!.committed).toMatchObject({ attachmentOwnership: { kind: 'queue', attachmentIds: ['owned-attachment'] }, draftReceipt: { sourceRevision: input.expectedRevision } })
    expect(attachments.findById('owned-attachment')).toMatchObject({ draftId: 'A', messageId: null })
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(events[1]!.committed).toMatchObject({ messageId: 'A', attachmentOwnership: { kind: 'message', attachmentIds: ['owned-attachment'] } })
    expect(events[1]!.committed?.draftReceipt).toBeUndefined()
    expect(events[1]!.committed?.commitId).not.toBe(events[0]!.committed?.commitId)
    expect(attachments.findById('owned-attachment')).toMatchObject({ draftId: null, messageId: 'A', conversationId: 'conversation' })
  })

  it('dispatches a queued message with a new turn batch without repeating draft consumption', async () => {
    const f = fixture()
    const events: TurnRequestCommit[] = []
    f.requests.onDidCommit(event => events.push(event))
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.settle('run-initial')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.facts.map(fact => fact.kind)).toEqual(['message.created', 'run.queued', 'queue.dispatched'])
  })

  it('keeps persisted waiting work paused when the owner restarts', async () => {
    const f = fixture(true)
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    f.continuation.reconcile()
    await f.continuation.start()
    expect(f.queue.list(f.scope)[0]?.state).toBe('paused')
    expect(f.launched).toEqual([])
  })

  it('resolves the current queue branch instead of treating a late settlement as a launch target', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    f.settled.fire({ runId: 'run-initial', conversationId: 'conversation', branchId: 'retired-branch', executionId: 'old-execution', cleanup: 'completed', stopping: false })
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.runs.findById('run-A')?.branchId).toBe('branch')
  })

  it('does not continue from a durable terminal until the execution slot is released', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.committed.fire({ runId: 'run-initial', type: 'run.completed', sequence: 1, createdAt: new Date().toISOString(), payload: {} })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.launched).toEqual([])
    f.settle('run-initial')
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.database.prepare('SELECT id FROM messages WHERE id = ?').all('A')).toHaveLength(1)
  })

  it('recovers a missed wake by reconciling current state', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    f.continuation.reconcile()
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
  })

  it('retains cleanup degradation when its settlement notification was missed', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot('degraded')
    f.continuation.reconcile()
    await vi.waitFor(() => expect(f.queue.list(f.scope)[0]?.state).toBe('paused'))
    expect(f.launched).toEqual([])
  })

  it('bounds failed reconciliation and recovers without silently resuming the paused queue', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    const unavailable = vi.spyOn(f.queue, 'list').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    f.continuation.reconcile()
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(3))
    expect(f.continuation.state).toBe('degraded')
    expect(f.launched).toEqual([])
    unavailable.mockRestore()
    expect(f.queue.list(f.scope)[0]?.state).toBe('paused')
    f.continuation.reconcile()
    await vi.waitFor(() => expect(f.continuation.state).toBe('ready'))
    expect(f.launched).toEqual([])
    expect(await f.service.steer(f.target('A'))).toBe(true)
    expect(f.launched).toEqual(['run-A'])
  })

  it('keeps a completed run paused when its execution cleanup degraded', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.settle('run-initial', 'degraded')
    await vi.waitFor(() => expect(f.queue.list(f.scope)[0]?.state).toBe('paused'))
    f.continuation.reconcile()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.launched).toEqual([])
  })

  it('does not start a new run when disposed during continuation validation', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    const stopped = f.continuation.dispose()
    f.service.dispose()
    gate.resolve()
    await stopped
    expect(f.launched).toEqual([])
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
  })

  it('rechecks durable storage health after asynchronous validation', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    f.eventLog.state = 'failed'
    gate.resolve()
    await f.service.drain()
    expect(f.launched).toEqual([])
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
  })

  it('steers only B and lazily follows up A then C within the same run', async () => {
    const f = fixture()
    for (const id of ['A', 'B', 'C'])
      f.queue.enqueue(f.input(id))
    expect(await f.service.steer(f.target('B'))).toBe(true)
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A', 'C'])
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['C'])
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(f.delivered).toEqual(['steer:B', 'followUp:A', 'followUp:C'])
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([
      { id: 'initial' },
      { id: 'B' },
      { id: 'A' },
      { id: 'C' },
    ])
  })

  it('preserves the settlement wake while a steering validation is in flight', async () => {
    const f = fixture()
    for (const id of ['A', 'B', 'C'])
      f.queue.enqueue(f.input(id))
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const steering = f.service.steer(f.target('B'))
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.settle('run-initial')
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve()
    expect(await steering).toBe(false)
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.delivered).toEqual([])
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['B', 'C'])
  })

  it('awaits an in-flight selected steer at the native follow-up boundary', async () => {
    const f = fixture()
    for (const id of ['A', 'B', 'C'])
      f.queue.enqueue(f.input(id))
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const steering = f.service.steer(f.target('B'))
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    const following = f.service.followUp('run-initial', f.controller.signal)
    gate.resolve()
    expect(await steering).toBe(true)
    expect(await following).toBe(true)
    expect(f.delivered).toEqual(['steer:B', 'followUp:A'])
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['C'])
  })

  it.each(['stop', 'cancel', 'dispose', 'pause'] as const)('does not consume an input after %s during async validation', async (action) => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const following = f.service.followUp('run-initial', f.controller.signal)
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    if (action === 'stop')
      f.controller.abort()
    else if (action === 'cancel')
      f.service.cancel(f.target('A'))
    else if (action === 'pause')
      f.queue.pause()
    else
      f.service.dispose()
    gate.resolve()
    expect(await following).toBe(false)
    expect(f.delivered).toEqual([])
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
  })

  it.each(['model', 'provider', 'reasoning', 'serviceTier', 'executionProfile', 'approvalPolicy', 'modelParameters'] as const)(
    'keeps a queued %s change for a new run with its original settings',
    async (field) => {
      const f = fixture()
      const input = f.input('A')
      if (field === 'reasoning')
        input.runInput.reasoning = 'high'
      else if (field === 'serviceTier')
        input.runInput.serviceTier = 'priority'
      else if (field === 'executionProfile')
        input.executionProfile = 'full_access'
      else if (field === 'approvalPolicy')
        input.approvalPolicy = 'manual'
      else if (field === 'modelParameters')
        input.modelParameters = { contextWindow: 32000, maxTokens: 2048 }
      else input[field] = 'changed'
      f.database.prepare('UPDATE conversations SET approval_policy = ?, execution_profile = ?').run(input.approvalPolicy, input.executionProfile)
      const draft = f.drafts.findById('draft')!
      f.drafts.save({ ...draft, expectedRevision: draft.revision, executionConfig: { approvalPolicy: input.approvalPolicy, executionProfile: input.executionProfile }, now: input.createdAt })
      input.draft.expectedRevision = f.drafts.findById('draft')!.revision
      f.queue.enqueue(input)
      f.queue.enqueue(f.input('C'))
      expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
      expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A', 'C'])
      f.database.exec('UPDATE runs SET status = \'completed\'')
      f.settle('run-initial')
      await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
      expect(f.runInputs.findByRunId('run-A')).toMatchObject(input.runInput)
      expect(f.runs.findById('run-A')).toMatchObject({ model: input.model, provider: input.provider, executionProfile: input.executionProfile, approvalPolicy: input.approvalPolicy })
    },
  )

  it.each(['followUp', 'steer'] as const)('keeps a review out of a writable run during %s and starts it read-only afterward', async (mode) => {
    const f = fixture()
    f.queue.enqueue({ ...f.input('review'), runExecutionProfile: 'read_only' })
    const accepted = mode === 'followUp'
      ? await f.service.followUp('run-initial', f.controller.signal)
      : await f.service.steer(f.target('review'))
    expect(accepted).toBe(false)
    expect(f.queue.pending(f.target('review'))?.runExecutionProfile).toBe('read_only')
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.runs.findById('run-review')?.executionProfile).toBe('read_only'))
    expect(f.queue.list(f.scope)).toEqual([])
    expect(f.database.prepare('SELECT execution_profile FROM conversations').get()).toEqual({ execution_profile: 'workspace_write' })
  })

  it('continues reviews in a read-only run but keeps ordinary writable input for a new run', async () => {
    const f = fixture()
    f.database.exec('UPDATE runs SET execution_profile = \'read_only\'')
    f.queue.enqueue({ ...f.input('review'), runExecutionProfile: 'read_only' })
    f.queue.enqueue(f.input('ordinary'))
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(await f.service.steer(f.target('ordinary'))).toBe(false)
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['ordinary'])
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'review' }])
  })

  it('pauses validation failures and prevents a paused head from being skipped', async () => {
    const f = fixture()
    for (const id of ['A', 'B'])
      f.queue.enqueue(f.input(id))
    f.validate.mockRejectedValueOnce(new Error('ATTACHMENT_NOT_FOUND'))
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    f.queue.enqueue(f.input('C'))
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(f.queue.list(f.scope).map(item => [item.id, item.state])).toEqual([
      ['A', 'paused'],
      ['B', 'paused'],
      ['C', 'waiting'],
    ])
    expect(await f.service.steer(f.target('B'))).toBe(true)
    expect(f.delivered).toEqual(['steer:B'])
  })

  it('retains a rejected native follow-up for a new run without duplicating its product message', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.runner.followUp.mockReturnValueOnce(false)
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(f.queue.pending(f.target('A'))).not.toBeNull()
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'A' }])
  })
})

function fixture(queuedOnStartup = false) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const drafts = createComposerDraftRepository(database)
  drafts.open({ draftId: 'draft', scope: { kind: 'global' }, initialContent: createBuddyUserContent('initial'), initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, now: '2026-09-15T00:00:00.000Z' })
  const input = (id: string): PrepareTurnRequestInput => ({
    ...drafts.findById('draft')!.executionConfig,
    attachmentBindings: [],
    branchId: 'branch',
    conversationId: 'conversation',
    createdAt: '2026-09-15T00:00:01.000Z',
    draft: { draftId: 'draft', expectedRevision: drafts.findById('draft')!.revision },
    model: 'model',
    provider: 'provider',
    requestId: `request-${id}`,
    requestFingerprint: id,
    runInput: { attachmentIds: [], contextItems: [], prompt: id, reasoning: null, serviceTier: null },
    runId: `run-${id}`,
    spaceId: null,
    title: 'queue',
    userMessageContent: { userContent: createBuddyUserContent(id), resourceSnapshots: [] },
    userMessageId: id,
  })
  const requests = new TurnRequestService(createTurnRequestRepository(database))
  requests.prepare(input('initial'))
  database.exec('UPDATE runs SET status = \'running\'')
  const queue = createChatQueueRepository(database)
  const runInputs = createRunInputRepository(database)
  const runs = createRunRepository(database)
  if (queuedOnStartup)
    queue.enqueue(input('A'))
  const delivered: string[] = []
  const deliver = (mode: string) => (_runId: string, prepare: () => BuddyInputReferenceV1) => {
    delivered.push(`${mode}:${prepare().messageId}`)
    return true
  }
  const settled = new Emitter<ExecutionSettled>(() => {})
  let occupied = true
  let cleanupDegraded = false
  const runner = { onDidSettle: settled.event, hasActiveExecution: () => occupied, hasDegradedCleanup: () => cleanupDegraded, isStopping: false, steer: vi.fn(deliver('steer')), followUp: vi.fn(deliver('followUp')) }
  const validate = vi.fn(async (_input: PrepareTurnRequestInput) => {})
  const launched: string[] = []
  const committed = new Emitter<BuddyRunEvent>(() => {})
  const eventLog: { onDidCommit: RunEventObservation['onDidCommit'], state: RunEventObservation['state'] } = { onDidCommit: committed.event, state: 'open' }
  const turns: ChatQueueServiceOptions['turns'] = {
    prepareStart: async () => {
      throw new Error('Use the persisted fixture')
    },
    validatePreparedInput: validate,
  }
  const service = new ChatQueueService({
    queue,
    eventLog,
    requests,
    runs,
    runInputs,
    runner,
    turns,
    launcher: { launch: async (runId) => {
      launched.push(runId)
      return { runId, completion: new Promise<never>(() => {}) }
    } },
  })
  const continuation = new QueueContinuation({ queue: service, runner, runs, eventLog })
  const settle = (runId: string, cleanup: ExecutionSettled['cleanup'] = 'completed') => {
    occupied = false
    cleanupDegraded = cleanup === 'degraded'
    settled.fire({ runId, conversationId: 'conversation', branchId: 'branch', executionId: runId, cleanup, stopping: false })
  }
  fixtures.push({ database, service, continuation })
  const scope = { conversationId: 'conversation', branchId: 'branch' }
  return { database, drafts, queue, input, service, continuation, settled, settle, committed, eventLog, releaseSlot: (cleanup: ExecutionSettled['cleanup'] = 'completed') => {
    occupied = false
    cleanupDegraded = cleanup === 'degraded'
  }, scope, target: (id: string) => ({ ...scope, id }), controller: new AbortController(), validate, delivered, launched, runInputs, runs, runner, requests, turns }
}
