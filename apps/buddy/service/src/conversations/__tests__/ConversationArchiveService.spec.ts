import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationArchiveRepository } from '../../storage/conversationArchiveRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ConversationArchiveService } from '../ConversationArchiveService'
import { ConversationLifecycleService } from '../ConversationLifecycleService'
import { ConversationMutationGuard } from '../ConversationMutationGuard'
import { ConversationPurgeService } from '../ConversationPurgeService'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(stop: () => Promise<number> = async () => 0) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const home = mkdtempSync(join(tmpdir(), 'lexora-archive-service-'))
  directories.push(home)
  const conversations = createConversationRepository(database)
  const repository = createConversationArchiveRepository(database)
  const deletion = createConversationDeletionRepository(database)
  const mutations = new ConversationMutationGuard()
  const purge = new ConversationPurgeService({ database, home })
  const lifecycle = new ConversationLifecycleService({ conversations, deletion, assertWritable: id => mutations.assertWritable(id), runner: { cancelAndWaitForConversation: stop }, cancelQueuedRuns: async () => {}, sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) }, purge: id => purge.purge(id) })
  const service = new ConversationArchiveService({ database, repository, conversations, mutations, lifecycle, now: () => new Date('2026-11-15T00:00:00.000Z'), onError: () => {} })
  const seed = (id: string) => {
    conversations.create({ id, branchId: `branch-${id}`, spaceId: null, title: 'Fixture task', createdAt: '2026-10-01T00:00:00.000Z', approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
      VALUES (?, ?, ?, 'user', '{}', '2026-10-01T00:00:00.000Z')`).run(`input-${id}`, id, `branch-${id}`)
    database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'queued', '2026-10-01T00:00:00.000Z')`).run(`run-${id}`, id, `branch-${id}`, `input-${id}`)
    database.prepare('INSERT INTO task_attention(conversation_id, seen_run_id) VALUES (?, ?)').run(id, `run-${id}`)
    database.prepare('UPDATE runs SET status = \'completed\' WHERE conversation_id = ?').run(id)
    database.prepare('UPDATE execution_state SET phase = \'closed\', cleanup_state = \'clean\' WHERE run_id = ?').run(`run-${id}`)
    const directory = join(home, 'conversations', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'private.txt'), 'fixture content')
    return directory
  }
  return { database, home, conversations, repository, deletion, mutations, lifecycle, service, seed }
}

describe('conversation archive lifecycle', () => {
  it('does not clear archives by default and expires only explicitly archived tasks', async () => {
    const f = fixture()
    const expired = f.seed('expired')
    const recent = f.seed('recent')
    const legacy = f.seed('legacy')
    f.repository.archive('expired', '2026-11-01T00:00:00.000Z')
    f.repository.archive('recent', '2026-11-14T00:00:00.000Z')
    f.conversations.markDeleted('legacy', '2026-10-01T00:00:00.000Z')
    await f.service.sweep()
    expect(f.service.getPolicy()).toEqual({ days: 0 })
    expect(existsSync(expired)).toBe(true)
    f.service.setPolicy(7)
    await f.service.sweep()
    expect(existsSync(expired)).toBe(false)
    expect(f.conversations.findById('expired')).toBeNull()
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(f.deletion.has('legacy')).toBe(false)
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    await f.service.dispose()
    await f.lifecycle.dispose()
  })

  it('holds the mutation gate while stopping and rejects stale restore without losing archive data', async () => {
    const stop = Promise.withResolvers<number>()
    const f = fixture(() => stop.promise)
    const directory = f.seed('task')
    const revision = f.conversations.findById('task')!.metadataRevision!
    const archiving = f.service.archive({ conversationId: 'task', expectedRevision: revision })
    expect(() => f.mutations.assertWritable('task')).toThrow()
    expect(f.conversations.findById('task')!.archivedAt).toBeNull()
    stop.resolve(0)
    expect(await archiving).toBe(true)
    expect(existsSync(directory)).toBe(true)
    expect(() => f.service.restore({ conversationId: 'task', expectedRevision: revision })).toThrow()
    expect(f.conversations.listRecent()).toEqual([])
    expect(f.service.restore({ conversationId: 'task', expectedRevision: f.conversations.findById('task')!.metadataRevision })).toBe(true)
    expect(f.conversations.listRecent().map(item => item.id)).toEqual(['task'])
    await f.service.dispose()
    await f.lifecycle.dispose()
  })

  it('persists a stop failure and never turns a legacy tombstone into a purge during recovery', async () => {
    let fail = true
    const f = fixture(async () => {
      if (fail)
        throw new Error('fixture stop failure')
      return 0
    })
    const directory = f.seed('task')
    const legacy = f.seed('legacy')
    f.conversations.markDeleted('legacy', '2026-10-01T00:00:00.000Z')
    await expect(f.service.deletePermanently({ conversationId: 'task', expectedRevision: f.conversations.findById('task')!.metadataRevision })).resolves.toBe(true)
    await f.lifecycle.settleDeletion('task').catch(() => {})
    expect(f.repository.list({ kind: 'deleting' }).items).toMatchObject([{ id: 'task', deletionStatus: 'failed' }])
    expect(existsSync(directory)).toBe(true)
    fail = false
    await f.lifecycle.recover('legacy')
    expect(existsSync(legacy)).toBe(true)
    expect(f.deletion.has('legacy')).toBe(false)
    await f.service.deletePermanently({ conversationId: 'task', expectedRevision: f.conversations.findById('task')!.metadataRevision })
    await f.lifecycle.settleDeletion('task')
    expect(existsSync(directory)).toBe(false)
    await f.service.dispose()
    await f.lifecycle.dispose()
  })

  it('restricts legacy cleanup to the confirmed removed revision', async () => {
    const f = fixture()
    const active = f.seed('active')
    const legacy = f.seed('legacy')
    await expect(f.service.deleteLegacyRemoved({ conversationId: 'active', expectedRevision: f.conversations.findById('active')!.metadataRevision })).rejects.toThrow()
    f.conversations.markDeleted('legacy', '2026-10-01T00:00:00.000Z')
    const revision = f.conversations.findById('legacy')!.metadataRevision!
    await expect(f.service.deleteLegacyRemoved({ conversationId: 'legacy', expectedRevision: revision + 1 })).rejects.toThrow()
    expect(await f.service.deleteLegacyRemoved({ conversationId: 'legacy', expectedRevision: revision })).toBe(true)
    await f.lifecycle.settleDeletion('legacy')
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(active)).toBe(true)
    await f.service.dispose()
    await f.lifecycle.dispose()
  })
})
