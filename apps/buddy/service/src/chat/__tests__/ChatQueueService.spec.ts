import type { DatabaseSync } from 'node:sqlite'
import type { BuddyInputReferenceV1 } from '../../agent/context/BuddyInputReference'
import type { PrepareTurnRequestInput } from '../../storage/turnRequestRepository'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createTurnRequestRepository } from '../../storage/turnRequestRepository'
import { ChatQueueService } from '../ChatQueueService'

const fixtures: Array<{ database: DatabaseSync, service: ChatQueueService }> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.dispose()
    fixture.database.close()
  }
})

describe('persistent chat queue scheduling', () => {
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
    f.service.onRunSettled('run-initial')
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
      f.service.onRunSettled('run-initial')
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
    f.service.onRunSettled('run-initial')
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
    f.service.onRunSettled('run-initial')
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'A' }])
  })
})

function fixture() {
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
  const requests = createTurnRequestRepository(database)
  requests.prepare(input('initial'))
  database.exec('UPDATE runs SET status = \'running\'')
  const queue = createChatQueueRepository(database)
  const runInputs = createRunInputRepository(database)
  const runs = createRunRepository(database)
  const delivered: string[] = []
  const deliver = (mode: string) => (_runId: string, prepare: () => BuddyInputReferenceV1) => {
    delivered.push(`${mode}:${prepare().messageId}`)
    return true
  }
  const runner = { steer: vi.fn(deliver('steer')), followUp: vi.fn(deliver('followUp')) }
  const validate = vi.fn(async (_input: PrepareTurnRequestInput) => {})
  const launched: string[] = []
  const service = new ChatQueueService({
    queue,
    requests,
    runs,
    runInputs,
    runner,
    turns: { prepareStart: async () => { throw new Error('Use the persisted fixture') }, validatePreparedInput: validate },
    launcher: { launch: async (runId) => {
      launched.push(runId)
      return { runId, completion: new Promise<never>(() => {}) }
    } },
  })
  fixtures.push({ database, service })
  const scope = { conversationId: 'conversation', branchId: 'branch' }
  return { database, drafts, queue, input, service, scope, target: (id: string) => ({ ...scope, id }), controller: new AbortController(), validate, delivered, launched, runInputs, runs, runner }
}
