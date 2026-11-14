import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationArchiveRpc } from '../../../../shared/conversation/conversationArchiveApi'
import { conversationCleanupRpc } from '../../../../shared/conversation/conversationCleanupApi'
import { createConversationArchiveRepository } from '../../storage/conversationArchiveRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ConversationArchiveService } from '../ConversationArchiveService'
import { ConversationCleanupService } from '../ConversationCleanupService'
import { ConversationLifecycleService } from '../ConversationLifecycleService'
import { ConversationMutationGuard } from '../ConversationMutationGuard'
import { ConversationPurgeService } from '../ConversationPurgeService'
import { registerConversationArchiveRpc } from '../registerConversationArchiveRpc'
import { registerConversationCleanupRpc } from '../registerConversationCleanupRpc'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const now = '2026-11-15T00:00:00.000Z'

function fixture(options: { legacyWrites?: boolean, stop?: () => Promise<number> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'lexora-legacy-archive-rpc-'))
  const path = join(home, 'buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath: path })
  const conversations = createConversationRepository(database)
  const repository = createConversationArchiveRepository(database)
  const mutations = new ConversationMutationGuard()
  const deletion = createConversationDeletionRepository(database)
  const purge = new ConversationPurgeService({ database, home, storageAuthority: 'legacy_jsonl' })
  const errors: unknown[] = []
  const lifecycle = new ConversationLifecycleService({
    conversations,
    deletion,
    assertWritable: id => mutations.assertWritable(id),
    runner: { cancelAndWaitForConversation: options.stop ?? (async () => 0) },
    cancelQueuedRuns: async () => {},
    sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) },
    purge: id => purge.purge(id),
  })
  const archive = new ConversationArchiveService({ database, repository, conversations, mutations, lifecycle, onError: error => errors.push(error), now: () => new Date(now) })
  const cleanup: ConversationCleanupService = new ConversationCleanupService({ database, archive, lifecycle, execute: input => cleanup.execute(input) })
  const handlers = new Map<string, RuntimeRequestHandler>()
  const rpc = { onRequest: (method: string, handler: RuntimeRequestHandler) => {
    handlers.set(method, handler)
    return () => {
      handlers.delete(method)
    }
  } }
  const dispose = registerConversationArchiveRpc({ archive, legacyWrites: options.legacyWrites ?? true, rpc })
  const disposeCleanup = registerConversationCleanupRpc({ rpc, cleanup })
  cleanups.push(async () => {
    dispose()
    disposeCleanup()
    await archive.dispose()
    await lifecycle.dispose()
    database.close()
    rmSync(home, { recursive: true, force: true })
  })
  const seed = (id: string) => {
    conversations.create({ id, branchId: `branch-${id}`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
    const directory = join(home, 'conversations', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'fixture.txt'), 'Preserve until confirmed cleanup')
    return directory
  }
  const target = (conversationId: string) => ({ conversationId, expectedRevision: conversations.findById(conversationId)!.metadataRevision! })
  const invoke = (method: keyof typeof conversationArchiveRpc, input: unknown) => Promise.resolve().then(() => handlers.get(conversationArchiveRpc[method].method)!(input, new AbortController().signal))
  const invokeCleanup = (method: keyof typeof conversationCleanupRpc, input: unknown) => Promise.resolve().then(() => handlers.get(conversationCleanupRpc[method].method)!(input, new AbortController().signal))
  return { database, path, conversations, repository, mutations, deletion, lifecycle, archive, cleanup, invokeCleanup, errors, seed, target, invoke }
}

describe('legacy conversation archive RPC', () => {
  it('exposes scoped domain cleanup without granting access to active or archived tasks', async () => {
    const f = fixture()
    const active = f.seed('active')
    const archived = f.seed('archived')
    const removed = f.seed('removed')
    await f.invoke('archive', f.target('archived'))
    f.conversations.markDeleted('removed', now)
    await expect(f.invokeCleanup('list', { scope: 'legacy_removed' })).resolves.toMatchObject({ items: [{ conversationId: 'removed' }] })
    for (const scope of [undefined, 'active', 'archived']) {
      await expect(f.invokeCleanup('list', { scope })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(f.invokeCleanup('delete', { ...f.target('removed'), scope })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    for (const id of ['active', 'archived'])
      await expect(f.invokeCleanup('delete', { ...f.target(id), scope: 'legacy_removed' })).resolves.toEqual({ status: 'failed', errorCode: 'SOURCE_CHANGED' })
    const target = f.target('removed')
    await expect(f.invokeCleanup('delete', { ...target, expectedRevision: target.expectedRevision + 1, scope: 'legacy_removed' })).resolves.toEqual({ status: 'failed', errorCode: 'SOURCE_CHANGED' })
    expect(existsSync(removed)).toBe(true)
    await expect(f.invokeCleanup('delete', { ...target, scope: 'legacy_removed' })).resolves.toEqual({ status: 'deleted' })
    expect(f.conversations.findById('removed')).toBeNull()
    expect(existsSync(removed)).toBe(false)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(archived)).toBe(true)
  })

  it('archives, restores, saves policy and deletes while preserving task data until deletion', async () => {
    const f = fixture()
    const directory = f.seed('task')
    const initial = f.target('task')
    await expect(f.invoke('archive', initial)).resolves.toBe(true)
    expect(existsSync(directory)).toBe(true)
    expect(f.conversations.listRecent()).toEqual([])
    await expect(f.invoke('listArchived', { kind: 'archived' })).resolves.toMatchObject({ items: [{ id: 'task', archivedAt: now, metadataRevision: initial.expectedRevision + 1 }] })
    await expect(f.invoke('restoreArchive', initial)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    await expect(f.invoke('restoreArchive', f.target('task'))).resolves.toBe(true)
    expect(f.conversations.listRecent().map(item => item.id)).toEqual(['task'])
    await expect(f.invoke('deleteArchived', f.target('task'))).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    await expect(f.invoke('archive', f.target('task'))).resolves.toBe(true)
    await expect(f.invoke('getArchivePolicy', {})).resolves.toEqual({ days: 0 })
    await expect(f.invoke('setArchivePolicy', { days: 7 })).resolves.toEqual({ days: 7 })
    await expect(f.invoke('deleteArchived', f.target('task'))).resolves.toBe(true)
    await f.lifecycle.settleDeletion('task')
    expect(f.errors).toEqual([])
    expect(f.conversations.findById('task')).toBeNull()
    expect(existsSync(directory)).toBe(false)
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('holds the mutation gate during stopping and rechecks the original CAS after stopping', async () => {
    const started = Promise.withResolvers<void>()
    const stop = Promise.withResolvers<number>()
    const f = fixture({ stop: () => {
      started.resolve()
      return stop.promise
    } })
    const directory = f.seed('task')
    const input = f.target('task')
    const pending = f.invoke('archive', input)
    await started.promise
    expect(f.conversations.findById('task')!.archivedAt).toBeNull()
    expect(() => f.mutations.assertWritable('task')).toThrow()
    await expect(f.invoke('restoreArchive', input)).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' })
    await expect(f.invoke('deleteArchived', input)).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' })
    f.database.prepare('UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = ?').run('task')
    stop.resolve(0)
    await expect(pending).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')!.archivedAt).toBeNull()
    expect(existsSync(directory)).toBe(true)
    expect(() => f.mutations.assertWritable('task')).not.toThrow()
  })

  it('preserves the active task and its data when stopping cannot finish', async () => {
    const f = fixture({ stop: async () => {
      throw new Error('Stop failed')
    } })
    const directory = f.seed('task')
    await expect(f.invoke('archive', f.target('task'))).rejects.toThrow('Stop failed')
    expect(f.conversations.findById('task')!.archivedAt).toBeNull()
    expect(existsSync(directory)).toBe(true)
    expect(f.deletion.has('task')).toBe(false)
    expect(() => f.mutations.assertWritable('task')).not.toThrow()
  })

  it('rejects raw writes when legacy mode is not explicitly enabled', async () => {
    const f = fixture({ legacyWrites: false })
    f.seed('task')
    for (const method of ['archive', 'restoreArchive', 'deleteArchived', 'setArchivePolicy'] as const) {
      await expect(f.invoke(method, method === 'setArchivePolicy' ? { days: 3 } : f.target('task'))).rejects.toMatchObject({ code: 'METHOD_NOT_AVAILABLE' })
    }
    await expect(f.invoke('listArchived', { kind: 'archived' })).resolves.toEqual({ items: [], nextCursor: null })
    await expect(f.invoke('getArchivePolicy', {})).resolves.toEqual({ days: 0 })
    expect(f.conversations.findById('task')!.archivedAt).toBeNull()
  })

  it('returns deletion admission before physical cleanup while holding the mutation gate until completion', async () => {
    const stop = Promise.withResolvers<number>()
    const f = fixture({ stop: () => stop.promise })
    const directory = f.seed('task')
    f.repository.archive('task', now)
    try {
      await expect(f.invoke('deleteArchived', f.target('task'))).resolves.toBe(true)
      expect(f.deletion.has('task')).toBe(true)
      expect(existsSync(directory)).toBe(true)
      expect(() => f.mutations.assertWritable('task')).toThrow()
    }
    finally { stop.resolve(0) }
    await f.lifecycle.settleDeletion('task')
    expect(existsSync(directory)).toBe(false)
    expect(() => f.mutations.assertWritable('task')).not.toThrow()
  })

  it('keeps legacy cleanup within confirmed tombstones and persists its job before stopping', async () => {
    const started = Promise.withResolvers<void>()
    const stop = Promise.withResolvers<number>()
    const f = fixture({ stop: () => {
      started.resolve()
      return stop.promise
    } })
    const removed = f.seed('removed')
    f.conversations.markDeleted('removed', now)
    const input = f.target('removed')
    await f.mutations.run('removed', async () => {
      await expect(f.cleanup.execute(input)).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' })
    })
    const pending = f.cleanup.delete({ ...input, scope: 'legacy_removed' })
    await started.promise
    expect(existsSync(removed)).toBe(true)
    expect(() => f.mutations.assertWritable('removed')).toThrow()
    const reader = new DatabaseSync(f.path, { readOnly: true })
    try {
      expect(reader.prepare('SELECT status, origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get('removed')).toMatchObject({ status: 'pending', origin: 'legacy_removed' })
    }
    finally { reader.close() }
    stop.resolve(0)
    await expect(pending).resolves.toEqual({ status: 'deleted' })
    expect(existsSync(removed)).toBe(false)
  })
})
