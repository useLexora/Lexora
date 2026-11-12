import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createExtensionTaskCleanup } from '../../../../platform/extensions/createExtensionTaskCleanup'
import { runExtensionTaskCleanupBatch } from '../../../../platform/extensions/ExtensionTaskCleanupBatch'
import { createConversationArchiveRepository } from '../../storage/conversationArchiveRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ConversationArchiveService } from '../ConversationArchiveService'
import { ConversationCleanupService } from '../ConversationCleanupService'
import { ConversationLifecycleService } from '../ConversationLifecycleService'
import { ConversationMutationGuard } from '../ConversationMutationGuard'
import { ConversationPurgeService } from '../ConversationPurgeService'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const home = mkdtempSync(join(tmpdir(), 'lexora-legacy-cleanup-'))
  const conversations = createConversationRepository(database)
  const repository = createConversationArchiveRepository(database)
  const deletion = createConversationDeletionRepository(database)
  const mutations = new ConversationMutationGuard()
  const purge = new ConversationPurgeService({ database, home })
  let fail = false
  const lifecycle = new ConversationLifecycleService({ conversations, deletion, assertWritable: id => mutations.assertWritable(id), runner: { cancelAndWaitForConversation: async () => {
    if (fail)
      throw new Error('FIXTURE_STOP_FAILURE')
    return 0
  } }, cancelQueuedRuns: async () => {}, sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) }, purge: id => purge.purge(id) })
  const archive = new ConversationArchiveService({ database, repository, conversations, mutations, lifecycle, onError: () => {} })
  const service = new ConversationCleanupService({ database, archive, lifecycle })
  const cleanup = createExtensionTaskCleanup({ list: async input => service.list(input), delete: input => service.delete(input) })
  disposers.push(async () => {
    await archive.dispose()
    await lifecycle.dispose()
    database.close()
    rmSync(home, { recursive: true, force: true })
  })
  function seed(id: string, kind: 'active' | 'archived' | 'removed') {
    conversations.create({ id, branchId: `branch-${id}`, spaceId: null, title: 'Fixture', createdAt: '2026-01-01T00:00:00Z', approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    if (kind === 'archived')
      repository.archive(id, '2026-01-02T00:00:00Z')
    if (kind === 'removed')
      conversations.markDeleted(id, '2026-01-02T00:00:00Z')
    const path = join(home, 'conversations', id)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'owned.txt'), 'fixture')
    return { conversationId: id, expectedRevision: conversations.findById(id)!.metadataRevision }
  }
  return { database, home, seed, cleanup, deletion, setFailure: (value: boolean) => {
    fail = value
  } }
}

it('cancellation creates no jobs and confirmation uses frozen CAS against a real database', async () => {
  const f = fixture()
  const target = f.seed('legacy', 'removed')
  f.seed('active', 'active')
  f.seed('archived', 'archived')
  const external = join(f.home, 'external.txt')
  writeFileSync(external, 'external fixture')
  const run = (confirm: Parameters<typeof runExtensionTaskCleanupBatch>[0]['confirm']) => runExtensionTaskCleanupBatch({ cleanup: { list: async input => f.cleanup.list(input), delete: input => f.cleanup.delete(input) }, assertCurrent: () => {}, confirm })
  expect(await run(async ({ total }) => total !== 1)).toEqual({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: 1, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 0, errorCode: null } })
  expect(f.database.prepare('SELECT * FROM conversation_deletion_jobs').all()).toEqual([])
  const changed = await run(async (preview) => {
    expect(preview).toEqual({ total: 1, skipped: 0 })
    f.database.prepare('UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = ?').run(target.conversationId)
    return true
  })
  expect(changed.results).toEqual([{ ...target, status: 'failed', errorCode: 'SOURCE_CHANGED' }])
  expect(changed.summary).toMatchObject({ phase: 'failed', total: 1, processed: 1, deleted: 0, pending: 0, failed: 1 })
  expect(f.database.prepare('SELECT * FROM conversation_deletion_jobs').all()).toEqual([])
  expect(existsSync(external)).toBe(true)
  expect(existsSync(join(f.home, 'conversations', 'legacy'))).toBe(true)
})

it('rejects active and archived targets and durably retries only a confirmed legacy tombstone', async () => {
  const f = fixture()
  for (const kind of ['active', 'archived'] as const) {
    const target = f.seed(kind, kind)
    expect(await f.cleanup.delete(target)).toEqual({ status: 'failed', errorCode: 'SOURCE_CHANGED' })
    expect(f.deletion.has(kind)).toBe(false)
  }
  const target = f.seed('legacy', 'removed')
  f.setFailure(true)
  expect((await f.cleanup.delete(target)).status).toBe('failed')
  expect(f.database.prepare('SELECT status, origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get('legacy')).toMatchObject({ status: 'failed', origin: 'legacy_removed' })
  expect(existsSync(join(f.home, 'conversations', 'legacy'))).toBe(true)
  f.setFailure(false)
  expect(await f.cleanup.delete(target)).toEqual({ status: 'deleted' })
  expect(existsSync(join(f.home, 'conversations', 'legacy'))).toBe(false)
  expect(existsSync(join(f.home, 'conversations', 'active'))).toBe(true)
  expect(existsSync(join(f.home, 'conversations', 'archived'))).toBe(true)
  expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
