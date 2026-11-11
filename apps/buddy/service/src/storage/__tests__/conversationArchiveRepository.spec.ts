import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationArchiveQuerySchema } from '../../../../shared/conversation/conversationArchiveApi'
import { createConversationArchiveRepository } from '../conversationArchiveRepository'
import { createConversationDeletionRepository } from '../conversationDeletionRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createSpaceRepository } from '../spaceRepository'

const now = '2026-11-01T00:00:00.000Z'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})
function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversations = createConversationRepository(database)
  const archive = createConversationArchiveRepository(database)
  const deletion = createConversationDeletionRepository(database)
  function seed(id: string, spaceId: string | null = null) {
    return conversations.create({ id, branchId: `branch-${id}`, spaceId, title: id, createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  return { database, conversations, archive, deletion, seed }
}

describe('v42 conversation archive repository', () => {
  it('hides archives from all normal indexes but preserves direct reading and revisioned restoration', () => {
    const f = fixture()
    const task = f.seed('target')
    f.seed('visible')
    expect(task).toMatchObject({ archivedAt: null, metadataRevision: expect.any(Number) })
    expect(f.archive.archive('target', now)).toBe(true)
    expect(f.conversations.findById('target')).toMatchObject({ archivedAt: now, metadataRevision: task.metadataRevision + 1 })
    expect(f.conversations.listRecent().map(task => task.id)).toEqual(['visible'])
    expect(f.conversations.listHistory({ kind: 'search', query: 'target' }).items).toEqual([])
    expect(f.conversations.getHistoryEntries(['target'])).toEqual([])
    expect(f.archive.restore('target', '2026-11-02T00:00:00.000Z')).toBe(true)
    expect(f.conversations.findById('target')).toMatchObject({ archivedAt: null, metadataRevision: task.metadataRevision + 2 })
    expect(f.conversations.getHistoryEntries(['target']).map(item => item.conversation.id)).toEqual(['target'])
  })

  it('binds archive cursors to their kind and search and orders tied timestamps by task ID', () => {
    const f = fixture()
    for (const id of ['target-a', 'target-b', 'other']) {
      f.seed(id)
      f.archive.archive(id, now)
    }
    const first = f.archive.list({ kind: 'archived', query: 'target', limit: 1 })
    expect(first.items.map(item => item.id)).toEqual(['target-b'])
    expect(first.nextCursor).toBeTypeOf('string')
    const second = f.archive.list({ kind: 'archived', query: 'target', limit: 1, cursor: first.nextCursor! })
    expect(second.items.map(item => item.id)).toEqual(['target-a'])
    expect(second.nextCursor).toBeNull()
    expect(() => f.archive.list({ kind: 'removed', query: 'target', cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => f.archive.list({ kind: 'archived', query: 'other', cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })

  it('manages archives and ordinary deletion jobs without exposing legacy cleanup records', () => {
    const f = fixture()
    f.seed('active')
    f.seed('archived')
    f.archive.archive('archived', now)
    f.seed('old-tombstone')
    f.conversations.markDeleted('old-tombstone', now)
    for (const status of ['pending', 'failed'] as const) {
      for (const source of ['active', 'archived', 'legacy'] as const) {
        const id = `${source}-${status}`
        f.seed(id)
        if (source === 'archived')
          f.archive.archive(id, now)
        if (source === 'legacy') {
          f.conversations.markDeleted(id, now)
          expect(f.deletion.commitLegacyRemoved(id, now)).not.toBeNull()
        }
        else {
          expect(f.deletion.commit(id, now)).not.toBeNull()
        }
        if (status === 'failed')
          f.deletion.failed(id, 'CONVERSATION_FILES_REFERENCED', now)
      }
    }

    const managed = f.archive.list(conversationArchiveQuerySchema.parse({ kind: 'managed' }))
    expect(managed.items.map(item => item.id)).toEqual(['archived-pending', 'archived-failed', 'archived', 'active-pending', 'active-failed'])
    expect(managed.nextCursor).toBeNull()
    expect(managed.items).toMatchObject([
      { archivedAt: now, deletedAt: now, deletionStatus: 'pending', errorCode: null },
      { archivedAt: now, deletedAt: now, deletionStatus: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' },
      { archivedAt: now, deletedAt: null, deletionStatus: null, errorCode: null },
      { archivedAt: null, deletedAt: now, deletionStatus: 'pending', errorCode: null },
      { archivedAt: null, deletedAt: now, deletionStatus: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' },
    ])
    expect(f.archive.list({ kind: 'archived' }).items.map(item => item.id)).toEqual(['archived'])
    expect(f.archive.list({ kind: 'removed' }).items.map(item => item.id)).toEqual(['old-tombstone', 'legacy-pending', 'legacy-failed'])
    expect(f.archive.list({ kind: 'deleting' }).items.map(item => item.id)).toEqual([
      'legacy-pending',
      'legacy-failed',
      'archived-pending',
      'archived-failed',
      'active-pending',
      'active-failed',
    ])
  })

  it('searches and paginates mixed managed states with kind-bound and query-bound cursors', () => {
    const f = fixture()
    for (const id of ['target-a', 'target-b', 'target-c', 'target-d', 'other', 'target-legacy', 'target-tombstone', 'target-active'])
      f.seed(id)
    for (const id of ['target-a', 'target-c', 'other'])
      f.archive.archive(id, now)
    for (const id of ['target-b', 'target-d'])
      f.deletion.commit(id, now)
    f.deletion.failed('target-b', 'CONVERSATION_FILES_REFERENCED', now)
    for (const id of ['target-legacy', 'target-tombstone'])
      f.conversations.markDeleted(id, now)
    f.deletion.commitLegacyRemoved('target-legacy', now)
    f.database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-11-02T00:00:00.000Z', 'target-a')

    const first = f.archive.list({ kind: 'managed', query: '  TARGET  ', limit: 2 })
    expect(first.items.map(item => item.id)).toEqual(['target-a', 'target-d'])
    expect(first.nextCursor).toBeTypeOf('string')
    const second = f.archive.list({ kind: 'managed', query: 'TARGET', limit: 2, cursor: first.nextCursor! })
    expect(second.items.map(item => item.id)).toEqual(['target-c', 'target-b'])
    expect(second.nextCursor).toBeNull()
    const boundary = f.archive.list({ kind: 'managed', query: 'TARGET', limit: 1, cursor: first.nextCursor! })
    expect(boundary.items.map(item => item.id)).toEqual(['target-c'])
    expect(boundary.nextCursor).toBeTypeOf('string')
    expect(f.archive.list({ kind: 'managed', query: 'TARGET', limit: 1, cursor: boundary.nextCursor! })).toMatchObject({
      items: [{ id: 'target-b' }],
      nextCursor: null,
    })
    expect(f.archive.list({ kind: 'managed', query: 'target', limit: 4 }).nextCursor).toBeNull()
    expect(f.archive.list({ kind: 'managed', query: 'absent' })).toEqual({ items: [], nextCursor: null })
    for (const kind of ['archived', 'removed', 'deleting'] as const)
      expect(() => f.archive.list({ kind, query: 'TARGET', cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => f.archive.list({ kind: 'managed', query: 'other', cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    const archived = f.archive.list({ kind: 'archived', query: 'TARGET', limit: 1 })
    expect(archived.nextCursor).toBeTypeOf('string')
    expect(() => f.archive.list({ kind: 'managed', query: 'TARGET', cursor: archived.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })

  it.each(['managed', 'archived', 'removed', 'deleting'] as const)('filters %s by Space before pagination and rejects cursors from another scope', (kind) => {
    const f = fixture()
    const spaces = createSpaceRepository(f.database)
    for (const id of ['space-a', 'space-b']) {
      spaces.create({ id, name: id, createdAt: now, memoryScope: 'space_only', primaryDirectory: null, additionalDirectories: [] })
    }
    const scopes = [null, 'space-a', 'space-b'] as const
    for (const spaceId of scopes) {
      for (const suffix of ['target-a', 'target-b', 'other']) {
        const id = `${spaceId ?? 'unbound'}-${suffix}`
        f.seed(id, spaceId)
        if (kind === 'removed') {
          f.conversations.markDeleted(id, now)
        }
        else if (kind === 'deleting' || (kind === 'managed' && suffix === 'target-b')) {
          f.deletion.commit(id, now)
          f.deletion.failed(id, 'CONVERSATION_FILES_REFERENCED', now)
        }
        else {
          f.archive.archive(id, now)
        }
      }
    }

    const all = f.archive.list({ kind, query: 'target' })
    expect(all.items.map(item => item.id)).toEqual([
      'unbound-target-b',
      'unbound-target-a',
      'space-b-target-b',
      'space-b-target-a',
      'space-a-target-b',
      'space-a-target-a',
    ])
    const allFirst = f.archive.list({ kind, query: 'target', limit: 1 })
    expect(allFirst.nextCursor).toBeTypeOf('string')
    for (const spaceId of scopes) {
      const input = conversationArchiveQuerySchema.parse({ kind, spaceId, query: 'target', limit: 1 })
      const first = f.archive.list(input)
      expect(first.items).toMatchObject([{ id: `${spaceId ?? 'unbound'}-target-b`, spaceId }])
      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).toBeTypeOf('string')
      const second = f.archive.list({ ...input, cursor: first.nextCursor! })
      expect(second.items).toMatchObject([{ id: `${spaceId ?? 'unbound'}-target-a`, spaceId }])
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(() => f.archive.list({ ...input, cursor: allFirst.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
      for (const otherSpaceId of [undefined, ...scopes]) {
        if (otherSpaceId !== spaceId)
          expect(() => f.archive.list({ ...input, spaceId: otherSpaceId, cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
      }
    }
    expect(f.archive.list({ kind, spaceId: 'missing', query: 'target' })).toEqual({ items: [], nextCursor: null })
  })

  it.each([3, 7, 30] as const)('expires only explicit archives at the exact %s-day boundary', (days) => {
    const f = fixture()
    f.seed('archived')
    f.seed('old-tombstone')
    f.archive.archive('archived', now)
    f.conversations.markDeleted('old-tombstone', now)
    expect(f.archive.getPolicy()).toEqual({ days: 0 })
    expect(f.archive.due('2027-01-01T00:00:00.000Z')).toEqual([])
    f.archive.setPolicy(days)
    const dueAt = Date.parse(now) + days * 24 * 60 * 60 * 1000
    expect(f.archive.due(new Date(dueAt - 1).toISOString())).toEqual([])
    expect(f.archive.due(new Date(dueAt).toISOString())).toEqual(['archived'])
    expect(f.archive.isDue('old-tombstone', new Date(dueAt).toISOString())).toBe(false)
    expect(f.deletion.pending()).toEqual([])
  })

  it('keeps failed deletion visible and blocks restore or repeat expiry while its job exists', () => {
    const f = fixture()
    f.seed('target')
    f.archive.archive('target', now)
    f.archive.setPolicy(3)
    f.deletion.commit('target', now)
    f.deletion.failed('target', 'CONVERSATION_FILES_REFERENCED', now)
    expect(f.archive.list({ kind: 'deleting' }).items).toMatchObject([{ id: 'target', deletionStatus: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' }])
    expect(f.archive.restore('target', now)).toBe(false)
    expect(f.archive.archive('target', now)).toBe(false)
    expect(f.archive.due('2027-01-01T00:00:00.000Z')).toEqual([])
    expect(f.deletion.pending()).toEqual([])
    f.deletion.retry('target', now)
    expect(f.deletion.pending()).toEqual(['target'])
  })
})
