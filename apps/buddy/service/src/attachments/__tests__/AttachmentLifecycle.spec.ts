import type { DatabaseSync } from 'node:sqlite'
import type { AttachmentChange } from '../attachmentEvents'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { AttachmentService } from '../AttachmentService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-attachment-lifecycle-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createAttachmentRepository(database)
  const service = new AttachmentService({ paths: new BuddyDataPaths(root), repository })
  const events: AttachmentChange[] = []
  service.onDidChange(event => events.push(event))
  cleanups.push(async () => {
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const [record] = await service.registerUploads('draft-1', [{ bytes: Uint8Array.of(1, 2, 3), mimeType: 'text/plain', name: 'source.txt' }])
  return { database, repository, service, events, record: record! }
}

function createConversation(database: DatabaseSync) {
  createConversationRepository(database).create({ id: 'conversation-1', branchId: 'branch-1', createdAt: '2026-09-28T00:00:00.000Z', spaceId: null, title: null, approvalPolicy: 'manual', executionProfile: 'read_only' })
}

describe('attachment facts and ownership', () => {
  it('preserves queued attachments until the queue relinquishes ownership', async () => {
    const { database, repository, record, service, events } = await setup()
    createConversation(database)
    database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('draft-1', 'conversation-1', 'branch-1', 'request-1', 'fingerprint', '{}', 'waiting', '2026-09-28T00:00:00.000Z')`).run()
    expect(await service.release([record.id])).toEqual([])
    expect(repository.findById(record.id)).not.toBeNull()
    expect([...await readFile(record.storedPath)]).toEqual([1, 2, 3])
    expect(events.map(event => event.kind)).toEqual(['file-published', 'registered'])
    database.prepare('UPDATE chat_queue SET state = \'cancelled\'').run()
    expect(await service.release([record.id])).toEqual([record.id])
    expect(repository.findById(record.id)).toBeNull()
    await expect(readFile(record.storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leases both draft and staged bytes until one immutable settlement completes', async () => {
    const { record, service, events } = await setup()
    const prepared = await service.prepareMessageAttachments({ attachmentIds: [record.id], conversationId: 'conversation-1', draftId: 'draft-1', messageId: 'message-1' })
    expect(Object.isFrozen(prepared.bindings[0])).toBe(true)
    await expect(service.prepareMessageAttachments({ attachmentIds: [record.id], conversationId: 'conversation-1', draftId: 'draft-1', messageId: 'message-1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await service.release([record.id])).toEqual([])
    expect((await service.reconcileStorage()).removedOrphanFiles).toBe(0)
    expect([...await readFile(prepared.bindings[0]!.storedPath)]).toEqual([1, 2, 3])
    await prepared.rollback()
    await prepared.rollback()
    await expect(prepared.commit()).rejects.toThrow('ATTACHMENT_PREPARATION_SETTLED')
    expect(events.filter(event => event.phase === 'rollback' && event.kind === 'cleanup-completed')).toHaveLength(1)
    expect(await service.release([record.id])).toEqual([record.id])
  })

  it('does not remove database-owned message bytes even when a caller requests rollback', async () => {
    const { database, record, service, repository } = await setup()
    const prepared = await service.prepareMessageAttachments({ attachmentIds: [record.id], conversationId: 'conversation-1', draftId: 'draft-1', messageId: 'message-1' })
    createConversation(database)
    database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (\'message-1\', \'conversation-1\', \'branch-1\', \'user\', \'{}\', \'2026-09-28T00:00:00.000Z\')').run()
    database.prepare('UPDATE attachments SET draft_id = NULL, message_id = \'message-1\', stored_path = ? WHERE id = ?').run(prepared.bindings[0]!.storedPath, record.id)
    await prepared.rollback()
    expect(repository.findById(record.id)?.messageId).toBe('message-1')
    expect([...await readFile(prepared.bindings[0]!.storedPath)]).toEqual([1, 2, 3])
    expect((await service.reconcileStorage()).removedOrphanFiles).toBe(1)
  })

  it('rejects cleanup before an ownership commit and preserves the draft for recovery', async () => {
    const { record, service, events } = await setup()
    const prepared = await service.prepareMessageAttachments({ attachmentIds: [record.id], conversationId: 'conversation-1', draftId: 'draft-1', messageId: 'message-1' })
    await expect(prepared.commit()).rejects.toThrow('ATTACHMENT_OWNERSHIP_NOT_COMMITTED')
    expect([...await readFile(record.storedPath)]).toEqual([1, 2, 3])
    expect(events.at(-1)).toMatchObject({ kind: 'cleanup-failed', phase: 'commit' })
    expect((await service.reconcileStorage()).removedOrphanFiles).toBe(1)
    expect(events[0]!.operationId).toBe(events[1]!.operationId)
  })
})

describe('prepared upload ownership', () => {
  it('releases only the newly prepared identity and keeps a completed queue transfer', async () => {
    const { database, record, service, repository } = await setup()
    const bytes = Uint8Array.of(65, 66)
    const prepared = await service.prepareUploads('draft-1', [{ name: 'temporary.txt', mimeType: 'text/plain', bytes }])
    bytes.fill(0)
    const temporary = prepared.records[0]!
    expect(Object.isFrozen(temporary)).toBe(true)
    expect(await service.release([temporary.id])).toEqual([])
    expect([...await readFile(temporary.storedPath)]).toEqual([65, 66])
    createConversation(database)
    database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('queue-1', 'conversation-1', 'branch-1', 'request-1', 'fingerprint', '{}', 'cancelled', '2026-09-28T00:00:00.000Z')`).run()
    database.prepare('UPDATE attachments SET draft_id = ? WHERE id = ?').run('queue-1', temporary.id)
    await prepared.rollback()
    expect(repository.findById(temporary.id)?.draftId).toBe('queue-1')
    expect([...await readFile(temporary.storedPath)]).toEqual([65, 66])
    expect(repository.findById(record.id)).not.toBeNull()
    expect(await service.release([temporary.id])).toEqual([temporary.id])
  })
})
