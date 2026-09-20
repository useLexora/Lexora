import type { DatabaseSync } from 'node:sqlite'
import type { PrepareTurnRequestInput } from '../turnRequestRepository'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createAttachmentRepository } from '../attachmentRepository'
import { createChatQueueRepository } from '../chatQueueRepository'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { openBuddyDatabase } from '../database'
import { createRunInputRepository } from '../runInputRepository'
import { createTurnRequestRepository } from '../turnRequestRepository'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const drafts = createComposerDraftRepository(database)
  drafts.open({ draftId: 'draft', scope: { kind: 'global' }, initialContent: createBuddyUserContent('initial'), initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, now: '2026-09-10T00:00:00.000Z' })
  const input = (id: string): PrepareTurnRequestInput => ({
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    attachmentBindings: [],
    branchId: 'branch',
    conversationId: 'conversation',
    createdAt: '2026-09-10T00:00:01.000Z',
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
  const turns = createTurnRequestRepository(database)
  turns.prepare(input('initial'))
  database.exec('UPDATE runs SET status = \'running\'')
  const queue = createChatQueueRepository(database)
  const scope = { conversationId: 'conversation', branchId: 'branch' }
  const target = (id: string) => ({ ...scope, id })
  return { database, drafts, input, queue, turns, scope, target }
}

describe('chat queue ownership and delivery', () => {
  it('cancels the middle item and submits the last as steering exactly once without consuming the head', () => {
    const f = fixture()
    for (const id of ['A', 'B', 'C'])
      f.queue.enqueue(f.input(id))
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A', 'B', 'C'])
    expect(f.queue.cancel(f.target('B'))).toBe(true)
    expect(f.queue.cancel(f.target('B'))).toBe(false)
    const c = f.queue.pending(f.target('C'))!
    f.queue.commitInRun(c, 'run-initial')
    expect(() => f.queue.commitInRun(c, 'run-initial')).toThrow()
    expect(f.queue.list(f.scope).map(item => item.id)).toEqual(['A'])
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'C' }])
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-initial' }])
    f.database.exec('UPDATE runs SET status = \'completed\'')
    expect(() => f.turns.prepare(f.input('bypass'))).toThrow()
    const a = f.queue.pending(f.target('A'))!
    expect(f.turns.prepare(a)).toMatchObject({ runId: 'run-A', created: true })
    expect(f.turns.prepare(a)).toMatchObject({ runId: 'run-A', created: false })
    expect(f.queue.list(f.scope)).toEqual([])
  })

  it('atomically refuses to commit a read-only review into a writable run', () => {
    const f = fixture()
    f.queue.enqueue({ ...f.input('review'), runExecutionProfile: 'read_only' })
    const pending = f.queue.pending(f.target('review'))!
    expect(() => f.queue.commitInRun(pending, 'run-initial')).toThrow()
    expect(f.queue.pending(f.target('review'))).toEqual(pending)
    expect(f.database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'initial' }])
    f.database.exec('UPDATE runs SET execution_profile = \'read_only\'')
    f.queue.commitInRun(pending, 'run-initial')
    expect(f.queue.list(f.scope)).toEqual([])
    expect(f.database.prepare('SELECT id FROM messages ORDER BY rowid').all()).toEqual([{ id: 'initial' }, { id: 'review' }])
  })

  it('protects queued image snapshots from draft cleanup and binds them to the delivered message', () => {
    const f = fixture()
    const attachments = createAttachmentRepository(f.database)
    attachments.create({ id: 'image', conversationId: null, messageId: null, draftId: 'draft', storedPath: '/test/draft.png', name: 'image.png', mimeType: 'image/png', sizeBytes: 12, createdAt: '2020-01-01T00:00:00.000Z' })
    const input = f.input('C')
    input.attachmentBindings = [{ id: 'image', sourceAttachmentId: 'image', sourceDraftId: 'draft', messageId: 'C', storedPath: '/test/snapshot.png', createdAt: input.createdAt, mimeType: 'image/png' }]
    input.runInput.attachmentIds = ['image']
    f.queue.enqueue(input)
    expect(attachments.findById('image')).toMatchObject({ draftId: 'C', messageId: null, storedPath: '/test/snapshot.png' })
    expect(attachments.removeDraft('image')).toBe(false)
    expect(attachments.listDraftsBefore('2026-01-01T00:00:00.000Z')).toEqual([])
    f.queue.pause()
    expect(f.queue.list(f.scope)[0]).toMatchObject({ state: 'paused', attachments: [{ id: 'image', name: 'image.png' }] })
    const runInputs = createRunInputRepository(f.database)
    expect(runInputs.findByMessageId('C')).toBeNull()
    f.queue.commitInRun(f.queue.pending(f.target('C'))!, 'run-initial')
    expect(runInputs.findByMessageId('C')).toMatchObject({ runId: 'run-initial', attachmentIds: ['image'], prompt: 'C' })
    expect(runInputs.findByTriggeringMessageId('C')).toBeNull()
    expect(runInputs.findByMessageId('initial')).toEqual(runInputs.findByRunId('run-initial'))
    expect(attachments.findById('image')).toMatchObject({ conversationId: 'conversation', messageId: 'C', draftId: null, storedPath: '/test/snapshot.png' })
  })

  it('rolls back stale draft admission and keeps newer draft edits when a queued followup starts', () => {
    const f = fixture()
    const stale = f.input('stale')
    const draft = f.drafts.findById('draft')!
    f.drafts.save({ ...draft, expectedRevision: draft.revision, content: createBuddyUserContent('new text'), now: '2026-09-10T00:00:02.000Z' })
    expect(() => f.queue.enqueue(stale)).toThrow()
    expect(f.queue.list(f.scope)).toEqual([])
    f.queue.enqueue(f.input('A'))
    const cleared = f.drafts.findById('draft')!
    f.drafts.save({ ...cleared, expectedRevision: cleared.revision, content: createBuddyUserContent('unsent text'), now: '2026-09-10T00:00:03.000Z' })
    f.database.exec('UPDATE runs SET status = \'completed\'')
    f.turns.prepare(f.queue.pending(f.target('A'))!)
    expect(f.drafts.findById('draft')?.content).toEqual(createBuddyUserContent('unsent text'))
    expect(f.queue.replay('request-A', 'A')).toMatchObject({ id: 'A' })
    expect(() => f.queue.replay('request-A', 'changed')).toThrow()
  })

  it('rejects an attachment handoff that does not match the queued message', () => {
    const f = fixture()
    const input = f.input('invalid')
    input.runInput.attachmentIds = ['missing']
    expect(() => f.queue.enqueue(input)).toThrow()
    expect(f.queue.list(f.scope)).toEqual([])
    expect(f.drafts.findById('draft')?.revision).toBe(input.draft.expectedRevision)
  })

  it('rejects cross-conversation actions and does not dispatch entries from a deleted conversation', () => {
    const f = fixture()
    f.queue.enqueue(f.input('A'))
    expect(f.queue.cancel({ ...f.target('A'), conversationId: 'another' })).toBe(false)
    f.database.exec('UPDATE conversations SET deleted_at = \'2026-09-10T00:00:04.000Z\'')
    expect(f.queue.list(f.scope)).toEqual([])
    expect(() => f.queue.pending(f.target('A'))).toThrow()
  })
})
