import type { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRunEventLog } from '../../events/createRunEventLog'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { ConversationLifecycleService } from '../ConversationLifecycleService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('conversationLifecycleService', () => {
  it('rolls back hiding when grant revocation fails in the same transaction', async () => {
    const f = deletionFixture()
    f.database.exec(`CREATE TRIGGER reject_grant_revocation BEFORE UPDATE ON conversation_directory_grants
      BEGIN SELECT RAISE(ABORT, 'revoke failed'); END;`)
    const commits: unknown[] = []
    f.service.onDidCommit(event => commits.push(event))
    await expect(f.service.delete('task-1')).rejects.toThrow('revoke failed')
    expect(f.conversations.findById('task-1')?.deletedAt).toBeNull()
    expect(f.grants.listActive('task-1')).toHaveLength(1)
    expect(commits).toEqual([])
  })

  it('coalesces cleanup and retries an existing tombstone without another deletion commit', async () => {
    const f = deletionFixture()
    const gate = Promise.withResolvers<number>()
    f.cancel.mockImplementationOnce(() => gate.promise)
    f.invalidate.mockResolvedValueOnce({ pending: 1, degraded: 0 })
    const commits: unknown[] = []
    const cleanup: string[] = []
    f.service.onDidCommit(event => commits.push(event))
    f.service.onDidCleanup(event => cleanup.push(event.status))
    const first = f.service.delete('task-1')
    expect(f.service.delete('task-1')).toBe(first)
    expect(f.conversations.findById('task-1')?.deletedAt).not.toBeNull()
    expect(f.grants.listActive('task-1')).toEqual([])
    gate.resolve(0)
    await expect(first).rejects.toMatchObject({ code: 'CONVERSATION_CLEANUP_PENDING' })
    await expect(f.service.delete('task-1')).resolves.toBe(false)
    expect(commits).toHaveLength(1)
    expect(cleanup).toEqual(['started', 'failed', 'started', 'completed'])
    await f.service.delete('task-1')
    expect(cleanup).toHaveLength(4)
  })

  it('recovers legacy tombstones with active grants and blocks a late grant', async () => {
    const f = deletionFixture()
    f.conversations.markDeleted('task-1', '2026-09-28T00:00:01.000Z')
    const commits: unknown[] = []
    f.service.onDidCommit(event => commits.push(event))
    expect(await f.service.recoverPendingDeletions()).toBe(1)
    expect(f.grants.listActive('task-1')).toEqual([])
    expect(commits).toEqual([expect.objectContaining({ tombstoned: false, revokedGrantIds: ['grant-1'] })])
    expect(() => f.grants.grant({ id: 'grant-late', conversationId: 'task-1', root: '/late', canonicalRoot: '/late', createdAt: new Date().toISOString() }))
      .toThrow(expect.objectContaining({ code: 'DIRECTORY_GRANT_OWNER_INVALID' }))
    expect(await f.service.recoverPendingDeletions()).toBe(0)
  })

  it('prevents a prepared run from entering execution after its task is tombstoned', async () => {
    const f = deletionFixture()
    f.conversations.createMessage({ id: 'message-1', conversationId: 'task-1', branchId: 'branch-1', runId: null, role: 'user', content: { text: 'Test' }, createdAt: '2026-09-28T00:00:00.000Z' })
    const runs = createRunRepository(f.database)
    runs.create({ id: 'run-late', conversationId: 'task-1', branchId: 'branch-1', triggeringMessageId: 'message-1', provider: 'fixture', model: 'fixture', piSessionFile: null, purpose: 'chat', status: 'queued', startedAt: '2026-09-28T00:00:00.000Z', approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    const root = await mkdtemp(join(tmpdir(), 'lexora-delete-queued-'))
    directories.push(root)
    const eventLog = createRunEventLog({ conversationsDirectory: root, database: f.database })
    const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
    f.cancelQueued.mockImplementation(async (conversationId) => {
      for (const run of runs.listIncomplete()) {
        if (run.conversationId === conversationId && run.status === 'queued')
          await lifecycle.finalize({ runId: run.id, status: 'cancelled', errorCode: 'RUN_CANCELLED', completedAt: new Date().toISOString() })
      }
    })
    await f.service.delete('task-1')
    expect(runs.markRunning('run-late', '2026-09-28T00:00:01.000Z')).toBe(false)
    expect(runs.findById('run-late')?.status).toBe('cancelled')
    expect((await eventLog.list('run-late')).map(event => event.type)).toEqual(['run.cancelled'])
    await eventLog.close()
  })

  it('hides the conversation while preserving product history and usage-owned files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-conversation-'))
    directories.push(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const directoryGrants = createConversationDirectoryGrantRepository(database)
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      requestId: 'request-1',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'hello',
        reasoning: null,
        serviceTier: null,
      },
      runId: 'run-1',
      title: null,
      userMessageContent: { text: 'hello' },
      userMessageId: 'message-1',
    })
    directoryGrants.grant({
      canonicalRoot: '/external',
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      id: 'grant-1',
      root: '/external',
    })
    const attachmentsRepository = createAttachmentRepository(database)
    const attachmentPath = join(root, 'attachment.txt')
    await writeFile(attachmentPath, 'attachment')
    attachmentsRepository.create({
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      draftId: null,
      id: 'attachment-1',
      messageId: 'message-1',
      mimeType: 'text/plain',
      name: 'attachment.txt',
      sizeBytes: 10,
      storedPath: attachmentPath,
    })
    const conversationsDirectory = join(root, 'conversations')
    const eventLog = createRunEventLog({ conversationsDirectory, database })
    await eventLog.append({ payload: {}, runId: 'run-1', type: 'run.started' })
    const sessionDirectory = join(
      conversationsDirectory,
      'conversation-1',
      'session',
      'branch-1',
    )
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, 'session.jsonl'), '{}\n')
    const cancelled = vi.fn(async () => 1)
    const invalidated = vi.fn(async () => ({ pending: 0, degraded: 0 }))
    const service = new ConversationLifecycleService({
      conversations,
      deletion: createConversationDeletionRepository(database),
      runner: { cancelAndWaitForConversation: cancelled },
      cancelQueuedRuns: async () => {},
      sessions: { invalidateConversation: invalidated },
    })

    await expect(service.delete('conversation-1')).resolves.toBe(true)
    expect(cancelled).toHaveBeenCalledBefore(invalidated)
    expect(conversations.findById('conversation-1')).not.toBeNull()
    expect(conversations.listRecent()).toEqual([])
    expect(attachmentsRepository.findVisibleById('attachment-1')).toBeNull()
    await expect(readFile(
      join(conversationsDirectory, 'conversation-1', 'events', 'run-1.jsonl'),
      'utf8',
    )).resolves.toContain('run.started')
    await expect(readFile(attachmentPath, 'utf8')).resolves.toBe('attachment')
    await expect(readFile(join(sessionDirectory, 'session.jsonl'), 'utf8')).resolves.toBe('{}\n')
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 1 })
    expect(conversations.findById('conversation-1')?.deletedAt).toEqual(expect.any(String))
    expect(directoryGrants.listActive('conversation-1')).toEqual([])
    await expect(service.delete('conversation-1')).resolves.toBe(false)
    expect(conversations.findById('conversation-1')).not.toBeNull()
    expect(conversations.listRecent()).toEqual([])
  })

  it('revokes conversation grants before asynchronous run cancellation', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const directoryGrants = createConversationDirectoryGrantRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-cancellation-failure',
      spaceId: null,
      title: null,
    })
    directoryGrants.grant({
      canonicalRoot: '/external',
      conversationId: 'conversation-cancellation-failure',
      createdAt: '2026-08-14T00:00:01.000Z',
      id: 'grant-1',
      root: '/external',
    })
    const invalidated = vi.fn(async () => ({ pending: 0, degraded: 0 }))
    const service = new ConversationLifecycleService({
      conversations,
      deletion: createConversationDeletionRepository(database),
      runner: {
        cancelAndWaitForConversation: vi.fn(async () => {
          throw new Error('cancellation failed')
        }),
      },
      cancelQueuedRuns: async () => {},
      sessions: { invalidateConversation: invalidated },
    })

    await expect(service.delete('conversation-cancellation-failure')).rejects.toThrow(
      'cancellation failed',
    )
    expect(directoryGrants.listActive('conversation-cancellation-failure')).toEqual([])
    expect(invalidated).not.toHaveBeenCalled()
  })
})

function deletionFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversations = createConversationRepository(database)
  conversations.create({ id: 'task-1', branchId: 'branch-1', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-28T00:00:00.000Z' })
  const grants = createConversationDirectoryGrantRepository(database)
  grants.grant({ id: 'grant-1', conversationId: 'task-1', root: '/external', canonicalRoot: '/external', createdAt: '2026-09-28T00:00:00.000Z' })
  const cancel = vi.fn(async () => 0)
  const cancelQueued = vi.fn(async (_conversationId: string) => {})
  const invalidate = vi.fn(async () => ({ pending: 0, degraded: 0 }))
  const service = new ConversationLifecycleService({ conversations, deletion: createConversationDeletionRepository(database), runner: { cancelAndWaitForConversation: cancel }, cancelQueuedRuns: cancelQueued, sessions: { invalidateConversation: invalidate } })
  return { database, conversations, grants, service, cancel, cancelQueued, invalidate }
}
