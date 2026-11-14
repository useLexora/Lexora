import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { BuddyServiceCommands } from '../../BuddyService'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductProtocolError } from '../../../../shared/productProtocol/errors'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { ConversationArchiveService } from '../../conversations/ConversationArchiveService'
import { ConversationCommandService } from '../../conversations/ConversationCommandService'
import { ConversationLifecycleService } from '../../conversations/ConversationLifecycleService'
import { ConversationMetadataService } from '../../conversations/ConversationMetadataService'
import { ConversationMutationGuard } from '../../conversations/ConversationMutationGuard'
import { registerConversationArchiveRpc } from '../../conversations/registerConversationArchiveRpc'
import { TaskMarkService } from '../../conversations/TaskMarkService'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createConversationArchiveRepository } from '../../storage/conversationArchiveRepository'
import { ConversationCommandRepository } from '../../storage/ConversationCommandRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { createTaskMarkRepository } from '../../storage/taskMarkRepository'
import { afterTransactionCommit } from '../../storage/transaction'
import { createProductCommandHandlers } from '../createProductCommandHandlers'
import { createProductSynchronization } from '../createProductSynchronization'
import { ProductConnection } from '../ProductConnection'
import { ProductQueries } from '../ProductQueries'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})
const now = '2026-11-07T00:00:00.000Z'
const initialize = { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'mobile', version: '1' }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] }

function fixture(prepare: () => Promise<number> = async () => 0) {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-archive-protocol-'))
  const database: DatabaseSync = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const conversations = createConversationRepository(database)
  conversations.create({ id: 'task', branchId: 'branch', spaceId: null, title: 'Archive fixture', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  const mutations = new ConversationMutationGuard()
  const effects: unknown[] = []
  const onError = (error: unknown) => effects.push(error)
  const sessions = { invalidateConversation: async () => ({ pending: 0, degraded: 0 }), refreshModelSelection: () => {} }
  const lifecycle = new ConversationLifecycleService({ conversations, deletion: createConversationDeletionRepository(database), assertWritable: id => mutations.assertWritable(id), runner: { cancelAndWaitForConversation: prepare }, cancelQueuedRuns: async () => {}, sessions, onObserverError: onError })
  const archive = new ConversationArchiveService({ database, repository: createConversationArchiveRepository(database), conversations, mutations, lifecycle, onError, afterCommit: publish => afterTransactionCommit(database, publish, onError), now: () => new Date(now) })
  const metadata = new ConversationMetadataService({ database, repository: conversations, buddies: createBuddyRepository(database), runs: createRunRepository(database), runInputs: createRunInputRepository(database), spaces: createSpaceRepository(database), spaceMoves: { mutations, hasPendingMessages: () => false, hasActiveExecution: () => false, validateTarget: async () => {} }, resolveModelSelection: async input => input, sessions, onObserverError: onError })
  const marks = new TaskMarkService(createTaskMarkRepository(database), onError, database)
  const principal = createLocalCommandPrincipal(database)
  const admission = new CommandAdmissionService({ database, principal, sourceInstanceId: 'instance' })
  const commands = new ConversationCommandService({ database, admission, repository: new ConversationCommandRepository(database), metadata, lifecycle, archive, marks, onEffectError: onError })
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const envelope = (commandId: string, intent: unknown) => ({ commandId, intent, dataGeneration, expectedServiceInstanceId: 'instance' })
  const handlers = createProductCommandHandlers({ commands: { admission, metadata: commands } as BuddyServiceCommands, assertOwner: (context) => {
    if (context.role !== 'owner')
      throw new ProductProtocolError('NOT_AUTHORIZED')
  }, allowedActions: new Set(), resolveQuote: () => { throw new Error('Unexpected quote') } })
  const idle = { onDidCommit: () => ({ dispose() {} }) }
  const queries = new ProductQueries(database, principal.actorId, 'instance')
  const sync = createProductSynchronization({ database, queries, archive, metadata, lifecycle, drafts: idle, events: idle })
  const clients: ProductConnection[] = []
  const connect = async (role: 'reader' | 'owner' = 'owner') => {
    const frames: Array<{ id: string, result?: Record<string, any>, error?: { code: string } }> = []
    const connection = new ProductConnection({ context: { serviceId: 'service', profileId: 'profile', dataGeneration, serviceInstanceId: 'instance', connectionId: `connection-${clients.length}`, clientSessionId: 'session', deviceId: 'device', ownerPrincipalId: 'owner', credentialId: 'credential', grantGeneration: '1', role }, assertCurrent: () => {}, phase: () => 'ready', handlers: { ...queries.handlers(), ...handlers }, sync: sync.publisher, authorizeTopic: sync.authorizeTopic, send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close: () => {} })
    clients.push(connection)
    let nextId = 0
    const send = async (method: string, params: unknown) => {
      const id = String(nextId++)
      await connection.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return frames.find(frame => frame.id === id)!
    }
    await send('initialize', initialize)
    return { send, frames }
  }
  cleanup.push(async () => {
    for (const client of clients) client.close()
    sync.dispose()
    await admission.dispose()
    await commands.dispose()
    await archive.dispose()
    await metadata.dispose()
    await lifecycle.dispose()
    marks.dispose()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const revision = () => conversations.findById('task')!.metadataRevision!
  return { database, conversations, archive, commands, admission, envelope, connect, revision, effects, handlers, sync, path: join(directory, 'buddy.sqlite3') }
}

describe('archive product commands', () => {
  it('keeps asynchronous preparation outside the receipt transaction and publishes only committed archive facts', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<number>()
    const f = fixture(() => {
      started.resolve()
      return release.promise
    })
    const client = await f.connect()
    const initialRevision = f.revision()
    const observed: boolean[] = []
    f.archive.onDidChange(() => {
      observed.push(!f.database.isTransaction && f.admission.lookup({ dataGeneration: f.envelope('archive', {}).dataGeneration, commandId: 'archive' }).lookup === 'decided')
    })
    const request = f.envelope('archive', { conversationId: 'task', expectedRevision: String(f.revision()) })
    const pending = client.send('conversations.archive', request)
    await started.promise
    expect(f.conversations.findById('task')?.archivedAt).toBeNull()
    expect(f.admission.lookup({ dataGeneration: request.dataGeneration, commandId: 'archive' })).toEqual({ lookup: 'pending' })
    expect(f.database.isTransaction).toBe(false)
    const duplicate = client.send('conversations.archive', request)
    release.resolve(0)
    const accepted = await pending
    expect((await duplicate).result?.receipt).toEqual(accepted.result?.receipt)
    expect(f.revision()).toBe(initialRevision + 1)
    expect(accepted.result?.receipt).toMatchObject({ decision: 'accepted', result: { archived: true } })
    expect(observed).toEqual([true])
    const listed = await client.send('conversations.listArchived', { kind: 'archived' })
    expect(listed.result?.items).toMatchObject([{ id: 'task', archivedAt: now, revision: String(f.revision()) }])
    expect(new ProductQueries(f.database, 'desktop-local', 'instance').read('conversations.list', { limit: 100, cursor: null })).toEqual({ items: [], nextCursor: null })
    const restored = await client.send('conversations.restoreArchive', f.envelope('restore', { conversationId: 'task', expectedRevision: String(f.revision()) }))
    expect(restored.result?.receipt.result).toEqual({ restored: true })
    expect((await client.send('conversations.archive', request)).result?.receipt).toEqual(accepted.result?.receipt)
    expect(f.conversations.findById('task')?.archivedAt).toBeNull()
    const reopened = new DatabaseSync(f.path, { readOnly: true })
    try {
      const admission = new CommandAdmissionService({ database: reopened, principal: createLocalCommandPrincipal(reopened), sourceInstanceId: 'reopened-instance' })
      expect(admission.lookup({ dataGeneration: request.dataGeneration, commandId: 'archive' })).toMatchObject({ lookup: 'decided', receipt: { decision: 'accepted', result: { archived: true } } })
      await admission.dispose()
    }
    finally { reopened.close() }
    expect(f.effects).toEqual([])
  })

  it('keeps archived history and exact subscriptions readable while rejecting metadata writes and deleted history', async () => {
    const f = fixture()
    const runs = createRunRepository(f.database)
    runs.create({ id: 'historical-run', conversationId: 'task', branchId: 'branch', triggeringMessageId: 'input', provider: 'fixture', model: 'model', purpose: 'chat', status: 'completed', startedAt: now, completedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
    f.conversations.createMessage({ id: 'historical-answer', conversationId: 'task', branchId: 'branch', runId: 'historical-run', role: 'assistant', content: { text: 'Archived answer' }, createdAt: now })
    const client = await f.connect()
    await client.send('conversations.archive', f.envelope('archive-readable', { conversationId: 'task', expectedRevision: String(f.revision()) }))
    expect((await client.send('conversations.list', {})).result?.items).toEqual([])
    expect((await client.send('conversations.get', { conversationId: 'task' })).result).toMatchObject({ id: 'task', revision: String(f.revision()) })
    expect((await client.send('conversations.listBranches', { conversationId: 'task' })).result?.items).toMatchObject([{ id: 'branch' }])
    expect((await client.send('conversations.listMessages', { conversationId: 'task', branchId: 'branch' })).result?.items).toMatchObject([{ id: 'historical-answer', body: { text: 'Archived answer' } }])
    expect((await client.send('runs.get', { runId: 'historical-run' })).result).toMatchObject({ id: 'historical-run' })
    expect((await client.send('runs.list', { conversationId: 'task', branchId: 'branch' })).result?.items).toMatchObject([{ id: 'historical-run' }])
    const snapshot = await client.send('sync.subscribe', { subscriptionId: 'archived-detail', topic: 'conversation:task:branch' })
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.result).toMatchObject({ mode: 'snapshot', items: [{ entity: 'task', value: { id: 'task' } }] })
    const denied = await client.send('conversations.rename', f.envelope('rename-archived', { conversationId: 'task', title: 'Must not change', expectedTitleRevision: String(f.conversations.findById('task')!.titleRevision) }))
    expect(denied.result?.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')?.title).toBe('Archive fixture')
    f.conversations.markDeleted('task', now)
    expect((await client.send('conversations.get', { conversationId: 'task' })).result).toBeNull()
    expect((await client.send('conversations.listBranches', { conversationId: 'task' })).result?.items).toEqual([])
    expect((await client.send('conversations.listMessages', { conversationId: 'task', branchId: 'branch' })).error?.code).toBe('OBJECT_DELETED')
    expect((await client.send('runs.get', { runId: 'historical-run' })).result).toBeNull()
    expect((await client.send('sync.subscribe', { subscriptionId: 'deleted-detail', topic: 'conversation:task:branch' })).error?.code).toBe('OBJECT_DELETED')
  })

  it('rejects stale revisions after preparation without committing an archive or changing the fixed rejection', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<number>()
    const f = fixture(() => {
      started.resolve()
      return release.promise
    })
    const client = await f.connect()
    const request = f.envelope('stale', { conversationId: 'task', expectedRevision: String(f.revision()) })
    const pending = client.send('conversations.archive', request)
    await started.promise
    f.database.prepare('UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = ?').run('task')
    release.resolve(0)
    const rejected = await pending
    expect(rejected.result?.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')?.archivedAt).toBeNull()
    expect((await client.send('conversations.archive', request)).result?.receipt).toEqual(rejected.result?.receipt)
  })

  it('requires owner role and an explicit decimal revision for optional archive capabilities', async () => {
    const f = fixture()
    const reader = await f.connect('reader')
    expect(reader.frames[0]?.result?.capabilities).not.toContain('conversations.listArchived')
    for (const [method, params] of [
      ['conversations.listArchived', { kind: 'archived' }],
      ['conversations.getArchivePolicy', {}],
      ['conversations.archive', f.envelope('reader-archive', { conversationId: 'task', expectedRevision: String(f.revision()) })],
      ['conversations.setArchivePolicy', f.envelope('reader-policy', { days: 3 })],
    ] as const) expect((await reader.send(method, params)).error?.code).toBe('NOT_AUTHORIZED')
    const owner = await f.connect()
    expect((await owner.send('conversations.archive', f.envelope('no-cas', { conversationId: 'task' }))).error?.code).toBe('INVALID_PARAMS')
    expect((await owner.send('conversations.archive', f.envelope('numeric-cas', { conversationId: 'task', expectedRevision: f.revision() }))).error?.code).toBe('INVALID_PARAMS')
    expect(f.database.prepare('SELECT count(*) AS count FROM command_receipts').get()!.count).toBe(0)
    expect(f.conversations.findById('task')?.archivedAt).toBeNull()
  })

  it('publishes archive removal and restore through the existing task index without changing old task DTOs', async () => {
    const f = fixture()
    const client = await f.connect()
    const frames: any[] = []
    const disconnect = f.sync.publisher.connect('phone', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close() {} })
    try {
      const subscription = f.sync.publisher.subscribe('phone', { subscriptionId: 'tasks', topic: 'taskIndex' })
      subscription.activate()
      f.sync.publisher.ack('phone', { subscriptionId: 'tasks', ...subscription.snapshot.cursor })
      await client.send('conversations.archive', f.envelope('archive', { conversationId: 'task', expectedRevision: String(f.revision()) }))
      await client.send('conversations.restoreArchive', f.envelope('restore', { conversationId: 'task', expectedRevision: String(f.revision()) }))
      const changes = frames.flatMap(frame => frame.params.changes ?? [])
      expect(changes).toMatchObject([{ kind: 'remove', id: 'task' }, { kind: 'upsert', value: { id: 'task' } }])
      expect(changes[1].value).not.toHaveProperty('archivedAt')
      expect(f.effects).toEqual([])
    }
    finally { disconnect() }
  })

  it('refuses raw runtime writes instead of bypassing durable command admission', async () => {
    const f = fixture()
    const handlers = new Map<string, RuntimeRequestHandler>()
    const dispose = registerConversationArchiveRpc({ archive: f.archive, rpc: { onRequest: (method, handler) => {
      handlers.set(method, handler)
      return () => {
        handlers.delete(method)
      }
    } } })
    try {
      for (const method of ['archive', 'restoreArchive', 'deleteArchived', 'setArchivePolicy']) {
        const input = method === 'setArchivePolicy' ? { days: 3 } : { conversationId: 'task', expectedRevision: f.revision() }
        await expect(Promise.resolve().then(() => handlers.get(`conversations.${method}`)!(input, new AbortController().signal))).rejects.toMatchObject({ code: 'METHOD_NOT_AVAILABLE' })
      }
      expect(f.archive.getPolicy()).toEqual({ days: 0 })
      expect(f.database.prepare('SELECT count(*) AS count FROM command_receipts').get()!.count).toBe(0)
      expect(f.conversations.findById('task')?.archivedAt).toBeNull()
    }
    finally { dispose() }
  })

  it('commits deletion acceptance with its purge job and never restores an accepted deletion', async () => {
    const f = fixture()
    const client = await f.connect()
    await client.send('conversations.archive', f.envelope('archive', { conversationId: 'task', expectedRevision: String(f.revision()) }))
    const request = f.envelope('delete', { conversationId: 'task', expectedRevision: String(f.revision()) })
    const accepted = await client.send('conversations.deleteArchived', request)
    expect(accepted.result?.receipt).toMatchObject({ decision: 'accepted', result: { deleted: true } })
    expect(f.database.prepare('SELECT status, origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get('task')).toMatchObject({ status: 'pending', origin: 'conversation' })
    expect((await client.send('conversations.listArchived', { kind: 'deleting' })).result?.items).toMatchObject([{ id: 'task', deletionStatus: 'pending' }])
    expect((await client.send('conversations.deleteArchived', request)).result?.receipt).toEqual(accepted.result?.receipt)
    expect((await client.send('conversations.restoreArchive', f.envelope('restore-deleting', { conversationId: 'task', expectedRevision: String(f.revision()) }))).result?.receipt).toMatchObject({ decision: 'rejected', errorCode: 'OBJECT_DELETED' })
    expect(f.effects).toEqual([])
  })

  it('restricts legacy cleanup to removed tasks and preserves its original durable receipt', async () => {
    const f = fixture()
    const client = await f.connect()
    const active = await client.send('conversations.deleteLegacyRemoved', f.envelope('active-legacy', { conversationId: 'task', expectedRevision: String(f.revision()) }))
    expect(active.result?.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.database.prepare('SELECT count(*) AS count FROM conversation_deletion_jobs').get()!.count).toBe(0)
    f.conversations.create({ id: 'ordinary', branchId: 'ordinary-branch', spaceId: null, title: 'Ordinary deletion', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
    createConversationDeletionRepository(f.database).commit('ordinary', now)
    const ordinaryRequest = f.envelope('ordinary-legacy', { conversationId: 'ordinary', expectedRevision: String(f.conversations.findById('ordinary')!.metadataRevision) })
    const rejected = await client.send('conversations.deleteLegacyRemoved', ordinaryRequest)
    expect(rejected.result?.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect((await client.send('conversations.deleteLegacyRemoved', ordinaryRequest)).result?.receipt).toEqual(rejected.result?.receipt)
    expect(f.database.prepare('SELECT origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get('ordinary')?.origin).toBe('conversation')
    f.conversations.markDeleted('task', now)
    const request = f.envelope('legacy', { conversationId: 'task', expectedRevision: String(f.revision()) })
    const accepted = await client.send('conversations.deleteLegacyRemoved', request)
    expect(accepted.result?.receipt).toMatchObject({ decision: 'accepted', result: { deleted: true } })
    expect(f.database.prepare('SELECT status, origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get('task')).toMatchObject({ status: 'pending', origin: 'legacy_removed' })
    expect((await client.send('conversations.deleteLegacyRemoved', request)).result?.receipt).toEqual(accepted.result?.receipt)
    expect(f.effects).toEqual([])
  })
})
