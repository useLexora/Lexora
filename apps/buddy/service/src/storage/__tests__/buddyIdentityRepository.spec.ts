import type { DatabaseSync } from 'node:sqlite'
import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import type { PrepareTurnRequestInput } from '../turnRequestRepository'
import { afterEach, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { buddyUserMessageContentV1Schema, createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createBuddyRepository } from '../buddyRepository'
import { createChatQueueRepository } from '../chatQueueRepository'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { createTurnRequestRepository } from '../turnRequestRepository'

let database: DatabaseSync
const now = '2026-10-11T00:00:00.000Z'
afterEach(() => database?.close())

function setup() {
  database = openBuddyDatabase({ databasePath: ':memory:' })
  return {
    buddies: createBuddyRepository(database),
    conversations: createConversationRepository(database),
    requests: createTurnRequestRepository(database),
    queue: createChatQueueRepository(database),
    runs: createRunRepository(database),
  }
}

function input(id: string, conversationId = 'conversation'): PrepareTurnRequestInput {
  const conversation = createConversationRepository(database).findById(conversationId)
  const draft = createComposerDraftRepository(database).open({
    draftId: `draft-${id}`,
    initialContent: createBuddyUserContent(id),
    initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
    initialModelSelection: null,
    now,
    scope: conversation
      ? { kind: 'conversation_branch', branchId: conversation.activeBranchId!, conversationId }
      : { kind: 'task', draftId: `draft-${id}`, spaceId: null },
  })
  return {
    attachmentBindings: [],
    branchId: conversation?.activeBranchId ?? `branch-${id}`,
    conversationId,
    createdAt: now,
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    draft: { draftId: draft.draftId, expectedRevision: draft.revision },
    model: 'fixture',
    provider: 'fixture',
    spaceId: null,
    requestId: `request-${id}`,
    requestFingerprint: `fingerprint-${id}`,
    runId: `run-${id}`,
    runInput: { attachmentIds: [], contextItems: [], prompt: id, reasoning: null, serviceTier: null },
    title: id,
    userMessageId: `message-${id}`,
    userMessageContent: { userContent: createBuddyUserContent(id), resourceSnapshots: [] },
  }
}

it('takes the default for new conversations and preserves run identities through switching, retries and removal', () => {
  const f = setup()
  const other = f.buddies.create({ name: 'Writer' })
  f.buddies.setDefault({ buddyId: other.id, expectedCatalogRevision: f.buddies.list().revision })
  f.requests.prepare(input('first'))
  expect(f.conversations.findById('conversation')?.buddyId).toBe(other.id)
  expect(f.runs.findById('run-first')?.buddyId).toBe(other.id)
  f.conversations.addMember({ id: 'conversation', buddyId: 'default', updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: 'default', updatedAt: now })
  expect(f.runs.findById('run-first')?.buddyId).toBe(other.id)
  database.exec('UPDATE runs SET status = \'failed\', error_code = \'RUNTIME_RESTARTED\'')
  f.requests.retryInterrupted({ requestId: 'request-first', runId: 'run-retry', createdAt: now })
  expect(f.runs.findById('run-retry')?.buddyId).toBe(other.id)
  database.exec('UPDATE runs SET status = \'completed\'')
  f.requests.prepare(input('second'))
  expect(f.runs.findById('run-second')?.buddyId).toBe('default')
  f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.buddies.setDefault({ buddyId: 'default', expectedCatalogRevision: f.buddies.list().revision })
  f.buddies.delete({ buddyId: other.id, expectedRevision: other.revision })
  database.exec('UPDATE runs SET status = \'completed\'')
  expect(() => f.requests.prepare(input('third'))).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  expect(f.runs.findById('run-third')).toBeNull()
  expect(f.runs.findById('run-first')?.buddyId).toBe(other.id)
  expect(f.buddies.get(other.id).name).toBe('Writer')
  expect(() => f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  const next = input('next', 'new-conversation')
  expect(() => f.requests.prepare({ ...next, buddyId: other.id })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  expect(f.conversations.findById('new-conversation')).toBeNull()
  f.requests.prepare(next)
  expect(f.runs.findById('run-next')?.buddyId).toBe('default')
})

it('retries the complete accepted definition after configuration, member model and application defaults change', () => {
  const f = setup()
  let actor = f.buddies.create({ name: 'Original' })
  actor = f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), instructions: 'ACCEPTED_INSTRUCTIONS', tools: { mode: 'none' }, skills: { mode: 'none' }, npcConcurrency: { mode: 'unlimited' }, limits: { fileAccess: 'read_only' } } })
  f.buddies.setDefault({ buddyId: actor.id, expectedCatalogRevision: f.buddies.state().revision })
  const original = input('captured')
  const actorSnapshot: BuddyExecutionDefinition = { version: 1, id: actor.id, revision: actor.revision, kind: 'actor', settings: buddySettingsSchema.parse(actor.settings), model: { providerId: 'fixture', modelId: 'accepted-model', reasoning: 'high', serviceTier: 'priority' }, modelSource: 'input' }
  f.requests.prepare({ ...original, buddyId: actor.id, actorSnapshot, provider: 'fixture', model: 'accepted-model', modelOverride: actorSnapshot.model })
  const effectiveModel = { ...actorSnapshot.model, modelId: 'effective-model', reasoning: 'xhigh' as const }
  f.runs.setModelSelection(original.runId, effectiveModel)
  f.runs.reconcileTerminal(original.runId, 'failed', now, 'RUNTIME_RESTARTED')
  f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), instructions: 'CHANGED_INSTRUCTIONS', tools: { mode: 'all' }, limits: { fileAccess: 'inherit' } } })
  f.conversations.setModelSelection({ id: 'conversation', actorId: actor.id, modelSelection: { providerId: 'new-provider', modelId: 'new-model', reasoning: null, serviceTier: null }, updatedAt: now })
  f.conversations.addMember({ id: 'conversation', buddyId: 'default', updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: 'default', updatedAt: now })
  f.buddies.setDefault({ buddyId: 'default', expectedCatalogRevision: f.buddies.state().revision })
  f.requests.retryInterrupted({ requestId: original.requestId, runId: 'retry-captured', createdAt: now })
  const retry = f.runs.findById('retry-captured')!
  expect(retry.actorSnapshot).toEqual(actorSnapshot)
  expect(retry).toMatchObject({ buddyId: actor.id, provider: 'fixture', model: 'accepted-model', modelOverride: effectiveModel })
  expect(database.prepare('SELECT actor_snapshot_json FROM runs WHERE id = ?').get('retry-captured')).toEqual(database.prepare('SELECT actor_snapshot_json FROM runs WHERE id = ?').get(original.runId))
  expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 1 })
  expect(f.conversations.findById('conversation')?.buddyId).toBe('default')
})

it('rejects stale queued actor admission without consuming the message', () => {
  const f = setup()
  f.requests.prepare(input('first'))
  database.exec('UPDATE runs SET status = \'running\'')
  const other = f.buddies.create({ name: 'Reviewer' })
  const queued = input('queued')
  f.queue.enqueue(queued)
  const saved = f.queue.pending({ id: 'message-queued', conversationId: 'conversation', branchId: 'branch-first' })!
  expect(saved.buddyId).toBe('default')
  f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: now })
  expect(() => f.queue.commitInRun(saved, 'run-first', undefined)).toThrow(expect.objectContaining({ code: 'BUDDY_CONFLICT' }))
  expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'message-first' }])
  expect(f.queue.list(saved)).toMatchObject([{ state: 'waiting' }])
  database.exec('UPDATE runs SET status = \'completed\'')
  expect(() => f.requests.prepare(saved)).toThrow(expect.objectContaining({ code: 'BUDDY_CONFLICT' }))
  expect(f.runs.findById('run-queued')).toBeNull()
  expect(f.queue.list(saved)).toHaveLength(1)
  const current = f.queue.pending({ ...saved, id: saved.queuedMessageId! })!
  expect(current.buddyId).toBe(other.id)
  f.requests.prepare(current)
  expect(f.runs.findById('run-queued')?.buddyId).toBe(other.id)
  expect(f.queue.list(saved)).toEqual([])
  expect(f.runs.findById('run-first')?.buddyId).toBe('default')
})

it('regenerates under the current companion without relabeling the original answer', () => {
  const f = setup()
  f.requests.prepare(input('first'))
  database.exec('UPDATE runs SET status = \'completed\'')
  f.conversations.createMessage({ id: 'answer', conversationId: 'conversation', branchId: 'branch-first', runId: 'run-first', role: 'assistant', content: { text: 'Original answer' }, createdAt: now })
  const other = f.buddies.create({ name: 'Reviewer' })
  f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.requests.regenerate({
    conversationId: 'conversation',
    branchId: 'regenerated',
    parentBranchId: 'branch-first',
    forkedFromMessageId: 'message-first',
    sourceRunId: 'run-first',
    createdAt: now,
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    model: 'fixture',
    provider: 'fixture',
    reasoning: null,
    serviceTier: null,
    expectedModelSelection: f.conversations.findById('conversation')!.modelSelection,
    requestId: 'regenerate',
    requestFingerprint: 'regenerate',
    runId: 'run-regenerated',
  })
  expect(f.runs.findById('run-regenerated')?.buddyId).toBe(other.id)
  expect(f.runs.findById('run-first')?.buddyId).toBe('default')
  expect(f.conversations.listBranchMessages('conversation', 'branch-first').map(message => message.id)).toContain('answer')
})

it('selects the previous journal from the admitted actor thread across leader switches', () => {
  const f = setup()
  f.requests.prepare(input('actor-a'))
  f.runs.bindSession('run-actor-a', '/fixture/actor-a.jsonl')
  f.runs.reconcileTerminal('run-actor-a', 'completed', now, null)
  const other = f.buddies.create({ name: 'Actor B' })
  f.conversations.addMember({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: other.id, updatedAt: now })
  f.requests.prepare(input('actor-b'))
  expect(f.runs.findById('run-actor-b')?.piSessionFile).toBeNull()
  f.runs.bindSession('run-actor-b', '/fixture/actor-b.jsonl')
  f.runs.reconcileTerminal('run-actor-b', 'completed', now, null)
  f.conversations.addMember({ id: 'conversation', buddyId: 'default', updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: 'default', updatedAt: now })
  f.requests.prepare(input('actor-a-next'))
  expect(f.runs.findById('run-actor-a-next')).toMatchObject({ buddyId: 'default', piSessionFile: '/fixture/actor-a.jsonl', threadId: f.runs.findById('run-actor-a')!.threadId })
  expect(f.runs.findById('run-actor-b')?.threadId).not.toBe(f.runs.findById('run-actor-a-next')?.threadId)
})

it('delivers a single explicit actor mention without changing the conversation leader', () => {
  const f = setup()
  const actor = f.buddies.create({ name: 'Reviewer' })
  const request = { ...input('direct'), buddyId: actor.id, leaderId: 'default', actorIds: [actor.id] }
  request.userMessageContent = { userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: actor.id, name: actor.name }, { type: 'text', text: ' Please review.' }] }] }, resourceSnapshots: [] }
  const drafts = createComposerDraftRepository(database)
  const saved = drafts.save({
    draftId: request.draft.draftId,
    expectedRevision: request.draft.expectedRevision,
    content: buddyUserMessageContentV1Schema.parse(request.userMessageContent).userContent,
    participants: { leaderId: 'default', actorIds: ['default', actor.id] },
    modelSelection: { providerId: 'fixture', modelId: 'actor-model', reasoning: null, serviceTier: null },
    executionConfig: { approvalPolicy: request.approvalPolicy, executionProfile: request.executionProfile },
    now,
  })
  request.draft.expectedRevision = saved.revision
  f.requests.prepare(request)
  expect(f.runs.findById('run-direct')?.buddyId).toBe(actor.id)
  expect(f.conversations.findById('conversation')?.buddyId).toBe('default')
  expect(f.conversations.findMember('conversation', 'default')).not.toBeNull()
  expect(f.conversations.findMember('conversation', actor.id)).not.toBeNull()
  expect(drafts.findById(saved.draftId)?.modelSelection).toBeNull()
  f.runs.reconcileTerminal('run-direct', 'completed', now, null)
  f.requests.prepare(input('ordinary'))
  expect(f.runs.findById('run-ordinary')?.buddyId).toBe('default')
})

it('drops an ordinary queued model override when the dispatch actor changes, while preserving explicit routing', () => {
  const f = setup()
  f.requests.prepare(input('first'))
  const actor = f.buddies.create({ name: 'Reviewer' })
  const selection = { providerId: 'fixture', modelId: 'model-for-original-actor', reasoning: null, serviceTier: null }
  const ordinary = { ...input('ordinary'), buddyId: 'default', modelOverride: selection }
  f.queue.enqueue(ordinary)
  const direct = { ...input('direct'), buddyId: 'default', actorIds: ['default'], modelOverride: selection }
  direct.userMessageContent = { userContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId: 'default', name: 'Lexora' }] }] }, resourceSnapshots: [] }
  f.queue.enqueue(direct)
  f.conversations.addMember({ id: 'conversation', buddyId: actor.id, updatedAt: now })
  f.conversations.setBuddy({ id: 'conversation', buddyId: actor.id, updatedAt: now })
  const changed = f.queue.pending({ id: ordinary.userMessageId, conversationId: 'conversation', branchId: ordinary.branchId })!
  expect(changed).toMatchObject({ buddyId: actor.id, queueRouting: { mode: 'current_actor' } })
  expect(changed.modelOverride).toBeUndefined()
  const pinned = f.queue.pending({ id: direct.userMessageId, conversationId: 'conversation', branchId: direct.branchId })!
  expect(pinned).toMatchObject({ buddyId: 'default', modelOverride: selection, queueRouting: { mode: 'actor', actorId: 'default' } })
})
