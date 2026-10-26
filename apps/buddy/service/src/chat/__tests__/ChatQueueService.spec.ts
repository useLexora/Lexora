import type { Api, Model } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { BuddyInputReferenceV1 } from '../../agent/context/BuddyInputReference'
import type { ExecutionSettled } from '../../agent/execution/ActiveRunRegistry'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { RunEventObservation } from '../../events/RunEventPorts'
import type { RuntimeModelProvider } from '../../providers/resolveInteractiveModelSelection'
import type { PrepareTurnRequestInput } from '../../storage/turnRequestRepository'
import type { ChatQueueChange, ChatQueueServiceOptions } from '../ChatQueueService'
import type { TurnRequestCommit } from '../TurnRequestService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { Emitter } from '../../../../shared/events/Emitter'
import { resolveBuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import { BuddyDefinitionResolver } from '../../buddies/BuddyDefinitionResolver'
import { RunEventCorruptionError } from '../../events/RunEventFailure'
import { toPublicRun } from '../../runs/publicRun'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationMemberRepository } from '../../storage/conversationMemberRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExecutionRepository } from '../../storage/executionRepository'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createThreadBindingRepository } from '../../storage/threadBindingRepository'
import { createTurnRequestRepository } from '../../storage/turnRequestRepository'
import { isReviewUserMessage } from '../buddyReviewPrompt'
import { ChatQueueService } from '../ChatQueueService'
import { ChatTurnService } from '../ChatTurnService'
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
  it('dispatches an explicitly addressed idle actor while the ordinary root keeps running', async () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Independent actor' })
    f.conversations.addMember({ id: 'conversation', buddyId: actor.id, updatedAt: '2026-10-25T00:00:00.000Z' })
    await f.enableDefinitions()
    const main = f.runs.findById('run-initial')!
    f.queue.enqueue({ ...f.input('directed'), buddyId: actor.id, actorIds: [actor.id], userMessageContent: {
      userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: actor.id, name: actor.name }, { type: 'text', text: 'Independent request' }] }] },
      resourceSnapshots: [],
    } })
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.runs.findById('run-directed')).toMatchObject({ buddyId: actor.id, schedulingLane: 'actor', status: 'queued' })
    expect(f.runs.findById('run-initial')).toEqual(main)
    expect(f.runs.findActiveForConversation('conversation')?.id).toBe('run-initial')
    expect(f.runs.findActiveForConversation('conversation', actor.id)?.id).toBe('run-directed')
  })

  it('keeps each actor queue ordered without letting a busy actor block an idle peer', async () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Available actor' })
    f.conversations.addMember({ id: 'conversation', buddyId: actor.id, updatedAt: '2026-10-25T00:00:00.000Z' })
    await f.enableDefinitions()
    f.queue.enqueue(f.input('busy'))
    for (const id of ['first', 'second']) {
      f.queue.enqueue({ ...f.input(id), buddyId: actor.id, actorIds: [actor.id], userMessageContent: {
        userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: actor.id, name: actor.name }, { type: 'text', text: id }] }] },
        resourceSnapshots: [],
      } })
    }
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.launched).toEqual(['run-first'])
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['busy', 'second'])
    expect(await f.service.reconcile(f.scope)).toBe(false)
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run('run-first')
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.launched).toEqual(['run-first', 'run-second'])
    expect(f.runs.findById('run-initial')?.status).toBe('running')
  })

  it('pauses a failed actor queue while another actor can still receive new work', async () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Available actor' })
    f.conversations.addMember({ id: 'conversation', buddyId: actor.id, updatedAt: '2026-10-25T00:00:00.000Z' })
    await f.enableDefinitions()
    f.queue.enqueue(f.input('failed-owner'))
    f.database.prepare('UPDATE runs SET status = \'failed\' WHERE id = ?').run('run-initial')
    f.releaseSlot()
    f.queue.enqueue({ ...f.input('peer'), buddyId: actor.id, actorIds: [actor.id], userMessageContent: {
      userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: actor.id, name: actor.name }, { type: 'text', text: 'Independent request' }] }] },
      resourceSnapshots: [],
    } })
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.queue.list(f.scope)).toMatchObject([{ id: 'failed-owner', state: 'paused' }])
    expect(f.launched).toEqual(['run-peer'])
  })

  it('keeps queued input undelivered in a quarantined conversation across steer, followup and dispatch', async () => {
    const failure = new RunEventCorruptionError('historical-run')
    const f = fixture(false, {
      assertConversationWritable: () => { throw failure },
      assertRunExecutable: () => { throw failure },
    })
    f.queue.enqueue(f.input('A'))
    await expect(f.service.steer(f.target('A'))).rejects.toBe(failure)
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    expect(await f.service.reconcile(f.scope)).toBe(false)
    expect(f.delivered).toEqual([])
    expect(f.launched).toEqual([])
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A'])
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
  })

  it('dispatches ordinary queued input to the current actor with its latest member model without altering the running actor', async () => {
    const f = fixture()
    const other = f.buddies.create({ name: 'Other' })
    f.members.setModelSelection({ conversationId: 'conversation', actorId: 'default', modelSelection: { providerId: 'provider', modelId: 'actor-a-member', reasoning: 'low', serviceTier: null }, updatedAt: '2026-10-11T10:00:00.000Z' })
    await f.enableDefinitions()
    const original = f.runs.findById('run-initial')!
    f.queue.enqueue({ ...f.input('A'), buddyId: 'default', actorSnapshot: original.actorSnapshot ?? undefined })
    f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
    f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
    f.members.setModelSelection({ conversationId: 'conversation', actorId: other.id, modelSelection: { providerId: 'provider', modelId: 'actor-b-member', reasoning: 'high', serviceTier: 'priority' }, updatedAt: '2026-10-11T10:00:02.000Z' })
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(await f.service.steer(f.target('A'))).toBe('incompatible')
    expect(f.delivered).toEqual([])
    expect(f.queue.list(f.scope)[0]?.buddyId).toBe(other.id)
    expect(f.runs.findById('run-initial')).toEqual(original)
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.runs.findById('run-A')).toMatchObject({ buddyId: other.id, model: 'actor-b-member', actorSnapshot: { id: other.id, modelSource: 'conversation' } })
    expect(f.runInputs.findByRunId('run-A')).toMatchObject({ reasoning: 'high', serviceTier: 'priority' })
    expect(f.members.find('conversation', 'default')?.modelSelection?.modelId).toBe('actor-a-member')
  })

  it('preserves the explicit actor and its queued model choice when the main actor changes', async () => {
    const f = fixture()
    const other = f.buddies.create({ name: 'Other' })
    await f.enableDefinitions()
    const modelOverride = { providerId: 'provider', modelId: 'explicit-input', reasoning: 'high' as const, serviceTier: 'priority' as const }
    f.queue.enqueue({ ...f.input('A'), actorIds: ['default'], modelOverride, userMessageContent: {
      userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'default', name: 'Lexora' }, { type: 'text', text: ' A' }] }] },
      resourceSnapshots: [],
    } })
    f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
    f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.runs.findById('run-A')).toMatchObject({ buddyId: 'default', model: modelOverride.modelId, actorSnapshot: { modelSource: 'input', model: modelOverride } })
    expect(f.members.find('conversation', 'default')).toMatchObject({ modelSelection: modelOverride, modelSelectionSource: 'explicit' })
    expect(f.members.find('conversation', other.id)?.modelSelection).toBeNull()
  })

  it('pauses a queued explicit actor disabled before dispatch without changing its target or consuming its input', async () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Fixed target' })
    await f.enableDefinitions()
    f.queue.enqueue({ ...f.input('A'), actorIds: [actor.id], userMessageContent: {
      userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: actor.id, name: actor.name }, { type: 'text', text: ' A' }] }] },
      resourceSnapshots: [],
    } })
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, enabled: false })
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    await expect(f.service.reconcile(f.scope)).rejects.toMatchObject({ code: 'BUDDY_DISABLED' })
    f.continuation.reconcile()
    await vi.waitFor(() => expect(f.queue.list(f.scope)[0]?.state).toBe('paused'))
    expect(f.runs.findById('run-A')).toBeNull()
    expect(f.queue.list(f.scope)).toEqual([expect.objectContaining({ id: 'A', state: 'paused', buddyId: actor.id })])
    expect(f.launched).toEqual([])
    expect(f.delivered).toEqual([])
    expect(f.database.prepare('SELECT count(*) AS count FROM messages WHERE id = ?').get('A')).toEqual({ count: 0 })
    expect(f.conversations.findById('conversation')?.buddyId).toBe('default')
  })

  it('keeps changed actor instructions and tool scope out of an existing run and captures them in a new run', async () => {
    const f = fixture()
    await f.enableDefinitions()
    const original = f.runs.findById('run-initial')!
    f.queue.enqueue(f.input('A'))
    const buddy = f.buddies.get('default')
    f.buddies.update({ buddyId: buddy.id, expectedRevision: buddy.revision, settings: buddySettingsSchema.parse({ ...buddy.settings, instructions: 'Updated instructions', tools: { mode: 'none' } }) })
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(await f.service.steer(f.target('A'))).toBe('incompatible')
    expect(f.runs.findById('run-initial')).toEqual(original)
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.runs.findById('run-A')?.actorSnapshot?.settings).toMatchObject({ instructions: 'Updated instructions', tools: { mode: 'none' } })
  })

  it('persists an explicit model choice that matches the active run when delivering a native continuation', async () => {
    const f = fixture()
    await f.enableDefinitions()
    const originalSnapshot = f.runs.findById('run-initial')?.actorSnapshot
    const modelOverride = { providerId: 'provider', modelId: 'model', reasoning: null, serviceTier: null }
    f.queue.enqueue({ ...f.input('A'), modelOverride })
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(f.members.find('conversation', 'default')).toMatchObject({ modelSelection: modelOverride, modelSelectionSource: 'explicit' })
    expect(f.runs.findById('run-A')).toBeNull()
    expect(f.runs.findById('run-initial')?.actorSnapshot).toEqual(originalSnapshot)
  })

  it.each(['actor', 'member_model', 'definition'] as const)('retains queued input when %s changes during async dispatch validation', async (change) => {
    const f = fixture()
    await f.enableDefinitions()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.releaseSlot()
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const dispatch = f.service.reconcile(f.scope)
    try {
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
      if (change === 'actor') {
        const other = f.buddies.create({ name: 'Other' })
        f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
        f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
      }
      else if (change === 'member_model') {
        f.members.setModelSelection({ conversationId: 'conversation', actorId: 'default', modelSelection: { providerId: 'provider', modelId: 'new-member-model', reasoning: null, serviceTier: null }, updatedAt: '2026-10-11T10:00:01.000Z' })
      }
      else {
        const buddy = f.buddies.get('default')
        f.buddies.update({ buddyId: buddy.id, expectedRevision: buddy.revision, settings: buddySettingsSchema.parse({ ...buddy.settings, instructions: 'Updated during validation' }) })
      }
    }
    finally { gate.resolve() }
    expect(await dispatch).toBe(false)
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A'])
    expect(f.runs.findById('run-A')).toBeNull()
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    expect(await f.service.reconcile(f.scope)).toBe(true)
    expect(f.runs.findById('run-A')?.buddyId).toBe(f.conversations.findById('conversation')?.buddyId)
  })

  it('does not deliver a stale actor after switching during async definition resolution', async () => {
    const f = fixture()
    await f.enableDefinitions()
    f.queue.enqueue(f.input('A'))
    const gate = Promise.withResolvers<void>()
    f.resolveModel.mockImplementationOnce(async (input) => {
      await gate.promise
      return f.model(input.modelId, input.providerId)
    })
    const steering = f.service.steer(f.target('A'))
    const other = f.buddies.create({ name: 'Other' })
    try {
      await vi.waitFor(() => expect(f.resolveModel).toHaveBeenCalledTimes(2))
      f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
      f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: '2026-10-11T10:00:01.000Z' })
    }
    finally { gate.resolve() }
    expect(await steering).toBe('unavailable')
    expect(f.delivered).toEqual([])
    expect(f.queue.list(f.scope)[0]?.buddyId).toBe(other.id)
  })

  it('pauses old and new inputs before cancellation settles and requires explicit continuation', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    const cleanup = Promise.withResolvers<void>()
    f.turns.cancel = async (runId) => {
      expect(f.queue.list(f.scope).map(item => item.state)).toEqual(['paused'])
      f.database.prepare('UPDATE runs SET status = ? WHERE id = ?').run('cancelled', runId)
      await cleanup.promise
      return toPublicRun(f.runs.findById(runId)!, null)
    }
    const cancelling = f.service.cancelRun('run-initial')
    try {
      for (const id of ['B', 'C']) {
        const prepared = f.input(id)
        f.turns.prepareStart = async () => ({ prepared, stagedAttachments: { validate: () => {}, bindings: [], commit: async () => {}, rollback: async () => {} } })
        await f.service.enqueue({ draftId: 'draft', expectedRevision: prepared.draft.expectedRevision, requestId: prepared.requestId })
      }
      f.releaseSlot()
      expect(await f.service.steer(f.target('B'))).toBe('unavailable')
      expect(await f.service.reconcile(f.scope)).toBe(false)
      expect(f.queue.list(f.scope).map(item => [item.id, item.state])).toEqual([['A', 'paused'], ['B', 'paused'], ['C', 'paused']])
      expect(f.launched).toEqual([])
      expect(f.delivered).toEqual([])
    }
    finally {
      cleanup.resolve()
      await cancelling
    }
    await f.continuation.start()
    expect(f.launched).toEqual([])
    expect(await f.service.steer(f.target('B'))).toBe('accepted')
    f.database.prepare('UPDATE runs SET status = ? WHERE id = ?').run('running', 'run-B')
    expect(await f.service.followUp('run-B', f.controller.signal)).toBe(false)
    expect(f.launched).toEqual(['run-B'])
    expect(f.queue.list(f.scope).map(item => [item.id, item.state])).toEqual([['A', 'paused'], ['C', 'paused']])
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'B' }])
  })

  it('does not pause a newer run queue when a stale stop arrives during its cleanup', async () => {
    const f = fixture()
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.requests.prepare(f.input('new'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.queue.enqueue(f.input('A'))
    await f.service.cancelRun('run-initial')
    expect(f.queue.list(f.scope).map(item => [item.id, item.state])).toEqual([['A', 'waiting']])
  })

  it('withdraws a steering input whose validation crosses the stop request', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    const validation = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => validation.promise)
    f.turns.cancel = async (runId) => {
      await cleanup.promise
      return toPublicRun(f.runs.findById(runId)!, null)
    }
    const steering = f.service.steer(f.target('A'))
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    const cancelling = f.service.cancelRun('run-initial')
    try {
      validation.resolve()
      expect(await steering).toBe('unavailable')
      expect(f.delivered).toEqual([])
      expect(f.queue.list(f.scope)[0]?.state).toBe('paused')
    }
    finally {
      validation.resolve()
      cleanup.resolve()
      await cancelling
    }
  })

  it('preserves inputs after a cancellation failure and releases the continuation guard', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.turns.cancel = async () => {
      throw new Error('Cancellation failed')
    }
    await expect(f.service.cancelRun('run-initial')).rejects.toThrow('Cancellation failed')
    expect(f.queue.list(f.scope)[0]?.state).toBe('paused')
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(await f.service.steer(f.target('A'))).toBe('accepted')
    expect(f.delivered).toEqual(['steer:A'])
  })

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

  it('delivers an addressed attachment to the live actor child once without consuming the caller input', async () => {
    const f = fixture()
    const caller = f.buddies.create({ name: 'Caller' })
    f.conversations.addMember({ id: 'conversation', buddyId: caller.id, updatedAt: '2026-10-25T00:00:00.000Z' })
    f.runs.create({ ...f.runs.findById('run-initial')!, id: 'caller', buddyId: caller.id, rootRunId: 'caller', threadId: createThreadBindingRepository(f.database).ensureActor('conversation', caller.id, '2026-10-25T00:00:00.000Z').id, schedulingLane: 'actor' })
    f.database.prepare('UPDATE runs SET execution_kind = \'actor_child\', parent_run_id = \'caller\', root_run_id = \'caller\' WHERE id = \'run-initial\'').run()
    const before = f.runs.findById('caller')
    const attachments = createAttachmentRepository(f.database)
    attachments.create({ id: 'directed-attachment', conversationId: null, draftId: 'draft', messageId: null, name: 'requirements.txt', mimeType: 'text/plain', sizeBytes: 12, storedPath: '/private/source.txt', createdAt: '2026-10-25T00:00:00.000Z' })
    const prepared = { ...f.input('directed-file'), buddyId: 'default', actorIds: ['default'] }
    prepared.runInput.attachmentIds = ['directed-attachment']
    prepared.userMessageContent = { userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'default', name: 'Lexora' }, { type: 'text', text: 'Use the attached requirements' }] }] }, resourceSnapshots: [] }
    const binding = { id: 'directed-attachment', sourceAttachmentId: 'directed-attachment', sourceDraftId: 'draft', messageId: prepared.userMessageId, storedPath: '/private/destination.txt', sourceStoredPath: '/private/source.txt', name: 'requirements.txt', sizeBytes: 12, mimeType: 'text/plain', createdAt: prepared.createdAt }
    prepared.attachmentBindings = [binding]
    f.turns.prepareStart = async () => ({ prepared, stagedAttachments: { validate: () => {}, bindings: [binding], commit: async () => {}, rollback: async () => {} } })
    const executions = createExecutionRepository(f.database)
    expect(executions.listAttachments('run-initial')).toEqual([])
    const references: BuddyInputReferenceV1[] = []
    f.runner.steer.mockImplementation((runId, prepare) => {
      expect(runId).toBe('run-initial')
      references.push(prepare())
      return true
    })
    const request = { requestId: prepared.requestId, draftId: 'draft', expectedRevision: prepared.draft.expectedRevision }
    await f.service.enqueue(request)
    await vi.waitFor(() => expect(references).toHaveLength(1))
    await f.service.enqueue(request)
    expect(references).toMatchObject([{ attachmentIds: ['directed-attachment'], messageId: 'directed-file' }])
    expect(executions.listAttachments('run-initial')).toEqual(['directed-attachment'])
    expect(executions.listContext('run-initial').map(material => material.sourceId)).toContain('message:directed-file')
    expect(attachments.findById('directed-attachment')).toMatchObject({ draftId: null, messageId: 'directed-file', conversationId: 'conversation' })
    expect(f.database.prepare('SELECT run_id FROM chat_queue WHERE id = ?').get('directed-file')).toEqual({ run_id: 'run-initial' })
    expect(f.runs.findById('caller')).toEqual(before)
    expect(f.runs.findById('run-directed-file')).toBeNull()
    expect(f.queue.list(f.scope)).toEqual([])
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

  it('waits for slot release then dispatches one turn batch without repeating draft consumption', async () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    const events: TurnRequestCommit[] = []
    f.requests.onDidCommit(event => events.push(event))
    f.committed.fire({ runId: 'run-initial', type: 'run.completed', sequence: 1, createdAt: new Date().toISOString(), payload: {} })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.launched).toEqual([])
    f.settle('run-initial')
    f.settle('run-initial')
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.database.prepare('SELECT id FROM messages WHERE id = ?').all('A')).toHaveLength(1)
    expect(events.map(event => event.facts.map(fact => fact.kind))).toEqual([['message.created', 'run.queued', 'queue.dispatched']])
  })

  it.each(['settlement', 'reconciliation'] as const)('keeps completed work paused after degraded cleanup through %s', async (wake) => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    f.database.exec('UPDATE runs SET status = \'completed\'')
    if (wake === 'settlement') {
      f.settle('run-initial', 'degraded')
    }
    else {
      f.releaseSlot('degraded')
      f.continuation.reconcile()
    }
    await vi.waitFor(() => expect(f.queue.list(f.scope)[0]?.state).toBe('paused'))
    f.continuation.reconcile()
    await new Promise(resolve => setTimeout(resolve, 15))
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
    await vi.waitFor(() => expect(f.continuation.state).toBe('degraded'))
    expect(f.launched).toEqual([])
    unavailable.mockRestore()
    expect(f.queue.list(f.scope)[0]?.state).toBe('paused')
    f.continuation.reconcile()
    await vi.waitFor(() => expect(f.continuation.state).toBe('ready'))
    expect(f.launched).toEqual([])
    expect(await f.service.steer(f.target('A'))).toBe('accepted')
    expect(f.launched).toEqual(['run-A'])
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

  it('serializes in-flight steering B before following up A then C within the same run', async () => {
    const f = fixture()
    for (const id of ['A', 'B', 'C'])
      f.queue.enqueue(f.input(id))
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const steering = f.service.steer(f.target('B'))
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    const following = f.service.followUp('run-initial', f.controller.signal)
    gate.resolve()
    expect(await steering).toBe('accepted')
    expect(await following).toBe(true)
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
    expect(await steering).toBe('unavailable')
    await vi.waitFor(() => expect(f.launched).toEqual(['run-A']))
    expect(f.delivered).toEqual([])
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['B', 'C'])
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

  it.each(([
    { from: 'read_only', to: 'full_access' },
    { from: 'full_access', to: 'read_only' },
    { from: 'manual_approval', to: 'policy_approval' },
    { from: 'policy_approval', to: 'manual_approval' },
  ] as const).flatMap(transition => (['steer', 'followUp'] as const).map(mode => ({ ...transition, mode }))))(
    'delivers $mode in the same run after switching permissions from $from to $to',
    async ({ from, to, mode }) => {
      const f = fixture()
      await f.enableDefinitions()
      const initial = resolveBuddyPermissionSettings(from)
      f.setPermissions(initial)
      f.database.prepare('UPDATE runs SET approval_policy = ?, execution_profile = ?').run(initial.approvalPolicy, initial.executionProfile)
      const original = f.runs.findById('run-initial')!
      if (mode === 'followUp')
        f.queue.enqueue(f.input('A'))
      f.setPermissions(resolveBuddyPermissionSettings(to))
      if (mode === 'steer')
        f.queue.enqueue(f.input('A'))
      expect(mode === 'steer' ? await f.service.steer(f.target('A')) : await f.service.followUp('run-initial', f.controller.signal)).toBe(mode === 'steer' ? 'accepted' : true)
      expect(f.delivered).toEqual([`${mode}:A`])
      expect(f.queue.list(f.scope)).toEqual([])
      expect(f.runInputs.findByMessageId('A')?.runId).toBe('run-initial')
      expect(f.runs.findById('run-initial')).toEqual(original)
      expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
    },
  )

  it.each(['steer', 'followUp'] as const)('retains input when permissions change during async $mode validation and accepts a retry under current permissions', async (mode) => {
    const f = fixture()
    await f.enableDefinitions()
    f.queue.enqueue(f.input('A'))
    const gate = Promise.withResolvers<void>()
    f.validate.mockImplementationOnce(() => gate.promise)
    const delivery = mode === 'steer' ? f.service.steer(f.target('A')) : f.service.followUp('run-initial', f.controller.signal)
    try {
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
      f.setPermissions(resolveBuddyPermissionSettings('read_only'))
    }
    finally { gate.resolve() }
    expect(await delivery).toBe(mode === 'steer' ? 'unavailable' : false)
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A'])
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    expect(mode === 'steer' ? await f.service.steer(f.target('A')) : await f.service.followUp('run-initial', f.controller.signal)).toBe(mode === 'steer' ? 'accepted' : true)
    expect(f.delivered).toEqual([`${mode}:A`])
    expect(f.runInputs.findByMessageId('A')?.runId).toBe('run-initial')
  })

  it.each(['model', 'provider', 'reasoning', 'serviceTier', 'modelParameters'] as const)(
    'keeps a queued %s change for a new run with its original settings',
    async (field) => {
      const f = fixture()
      const input = f.input('A')
      if (field === 'reasoning')
        input.runInput.reasoning = 'high'
      else if (field === 'serviceTier')
        input.runInput.serviceTier = 'priority'
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

  it.each([
    { mode: 'followUp', executionProfile: 'workspace_write' },
    { mode: 'steer', executionProfile: 'workspace_write' },
    { mode: 'followUp', executionProfile: 'read_only' },
    { mode: 'steer', executionProfile: 'read_only' },
  ] as const)('keeps a review out of an ordinary $executionProfile run during $mode and starts it read-only afterward', async ({ mode, executionProfile }) => {
    const f = fixture()
    f.database.prepare('UPDATE runs SET execution_profile = ?').run(executionProfile)
    f.queue.enqueue({ ...f.input('review'), runExecutionProfile: 'read_only' })
    const accepted = mode === 'followUp'
      ? await f.service.followUp('run-initial', f.controller.signal)
      : await f.service.steer(f.target('review'))
    expect(accepted).toBe(mode === 'steer' ? 'incompatible' : false)
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
    f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify({ userContent: createBuddyUserContent('/review inspect'), resourceSnapshots: [] }), 'initial')
    f.queue.enqueue({ ...f.input('review'), runExecutionProfile: 'read_only' })
    f.queue.enqueue(f.input('ordinary'))
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(true)
    expect(await f.service.followUp('run-initial', f.controller.signal)).toBe(false)
    expect(await f.service.steer(f.target('ordinary'))).toBe('incompatible')
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
    expect(await f.service.steer(f.target('B'))).toBe('accepted')
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

function fixture(queuedOnStartup = false, availability?: ChatQueueServiceOptions['availability']) {
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
  const conversations = createConversationRepository(database)
  const setPermissions = (settings: BuddyPermissionSettings) => {
    conversations.setPermissionSettings({ id: 'conversation', ...settings, updatedAt: '2026-10-12T00:00:00.000Z' })
    const draft = drafts.findById('draft')!
    drafts.save({ ...draft, expectedRevision: draft.revision, executionConfig: settings, now: '2026-10-12T00:00:00.000Z' })
  }
  const buddies = createBuddyRepository(database)
  const members = createConversationMemberRepository(database)
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
  const runner = { onDidSettle: settled.event, hasActiveExecution: (_conversationId?: string, actorId?: string) => occupied && (!actorId || actorId === 'default'), hasDegradedCleanup: () => cleanupDegraded, isStopping: false, steer: vi.fn(deliver('steer')), followUp: vi.fn(deliver('followUp')) }
  const validate = vi.fn(async (_input: PrepareTurnRequestInput) => {})
  const launched: string[] = []
  const committed = new Emitter<BuddyRunEvent>(() => {})
  const eventLog: { onDidCommit: RunEventObservation['onDidCommit'], state: RunEventObservation['state'] } = { onDidCommit: committed.event, state: 'open' }
  const turns: ChatQueueServiceOptions['turns'] = {
    cancel: async runId => toPublicRun(runs.findById(runId)!, null),
    prepareStart: async () => {
      throw new Error('Use the persisted fixture')
    },
    validatePreparedInput: validate,
    refreshQueuedInput: async input => input,
  }
  const service = new ChatQueueService({
    availability,
    getRunPermissionCeiling: (runId) => {
      const run = runs.findById(runId)
      return run?.triggeringMessageId && isReviewUserMessage(conversations.findMessageById(run.triggeringMessageId)?.content) ? 'read_only' : undefined
    },
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
  const model = (id: string, provider: string): Model<Api> => ({ api: 'openai-completions', baseUrl: 'https://models.example.test', id, provider, name: id, input: ['text'], reasoning: true, contextWindow: 32000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const resolveModel = vi.fn(async (input: { modelId: string, providerId: string }) => model(input.modelId, input.providerId))
  const providers: RuntimeModelProvider = { getDefaultModel: async () => ({ modelId: 'model', providerId: 'provider', reasoning: null, serviceTier: null }), executionModels: { resolveAvailable: resolveModel, getServiceTiers: () => [{ id: 'priority', displayName: 'Priority' }] } }
  const definitions = new BuddyDefinitionResolver({ buddies, members, providers })
  const actualTurns = new ChatTurnService({
    definitions,
    getDefaultBuddyId: () => 'default',
    conversations,
    conversationLifecycle: { isDeleting: () => false },
    drafts,
    providers,
    runInputs,
    runs,
    spaces: { findById: () => null },
    runner: { cancel: async () => false },
    skills: { materializeForSpace: async () => [] },
    inputValidation: { validate: async () => {} },
    attachments: {
      getInputMetadata: () => [],
      prepareMessageAttachments: async () => { throw new Error('Unused') },
      preparePrompt: async () => { throw new Error('Unused') },
    },
    turnLauncher: { launch: async () => { throw new Error('Unused') } },
    turnRequests: createTurnRequestRepository(database),
  })
  const enableDefinitions = async () => {
    const resolved = await definitions.resolve({ buddyId: 'default', kind: 'actor', conversationId: 'conversation' })
    database.prepare('UPDATE runs SET actor_snapshot_json = ?, model = ?, provider = ?, context_window = ?, max_tokens = ? WHERE id = ?').run(JSON.stringify(resolved.definition), resolved.selection.modelId, resolved.selection.providerId, resolved.selection.contextWindow, resolved.selection.maxTokens, 'run-initial')
    turns.refreshQueuedInput = input => actualTurns.refreshQueuedInput(input)
  }
  const settle = (runId: string, cleanup: ExecutionSettled['cleanup'] = 'completed') => {
    occupied = false
    cleanupDegraded = cleanup === 'degraded'
    settled.fire({ runId, conversationId: 'conversation', branchId: 'branch', executionId: runId, cleanup, stopping: false })
  }
  fixtures.push({ database, service, continuation })
  const scope = { conversationId: 'conversation', branchId: 'branch' }
  return { database, drafts, queue, input, service, continuation, settled, settle, committed, eventLog, buddies, members, conversations, setPermissions, enableDefinitions, resolveModel, model, releaseSlot: (cleanup: ExecutionSettled['cleanup'] = 'completed') => {
    occupied = false
    cleanupDegraded = cleanup === 'degraded'
  }, scope, target: (id: string) => ({ ...scope, id }), controller: new AbortController(), validate, delivered, launched, runInputs, runs, runner, requests, turns }
}
