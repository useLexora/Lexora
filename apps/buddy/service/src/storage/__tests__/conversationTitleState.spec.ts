import { describe, expect, it } from 'vitest'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'

describe('task title metadata', () => {
  it('preserves activity ordering and protects manual titles, concurrent writes and deleted tasks', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const repository = createConversationRepository(database)
      const createdAt = '2026-09-28T00:00:00.000Z'
      for (const id of ['older', 'newer'])
        repository.create({ id, branchId: `${id}-branch`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: id === 'older' ? createdAt : '2026-09-28T01:00:00.000Z' })
      expect(repository.renameGenerated({ id: 'older', title: 'Protected', expectedRevision: 0 })).toBeNull()
      database.prepare('UPDATE conversations SET title_source = ?, title_revision = 0 WHERE id = ?').run('fallback', 'older')
      expect(repository.renameGenerated({ id: 'older', title: 'Generated', expectedRevision: 0 })).toMatchObject({ title: 'Generated', updatedAt: createdAt })
      expect(repository.renameGenerated({ id: 'older', title: 'Late', expectedRevision: 0 })).toBeNull()
      expect(repository.rename({ id: 'older', title: 'Chosen by user' })).toMatchObject({ title: 'Chosen by user', updatedAt: createdAt })
      expect(repository.getTitleState('older')).toEqual({ title: 'Chosen by user', source: 'manual', revision: 2 })
      expect(repository.renameGenerated({ id: 'older', title: 'Overwrite', expectedRevision: 2 })).toBeNull()
      expect(repository.listRecent().map(task => task.id)).toEqual(['newer', 'older'])
      database.prepare('UPDATE conversations SET title_source = ?, title_revision = 0 WHERE id = ?').run('fallback', 'newer')
      repository.markDeleted('newer', '2026-09-28T02:00:00.000Z')
      expect(repository.getTitleState('newer')).toBeNull()
      expect(repository.renameGenerated({ id: 'newer', title: 'Deleted', expectedRevision: 0 })).toBeNull()
    }
    finally { database.close() }
  })
})
