import type { DatabaseSync } from 'node:sqlite'
import type { ConversationMetadataCommit } from '../ConversationMetadataService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ConversationMetadataService } from '../ConversationMetadataService'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('conversation metadata ownership', () => {
  it('publishes the actual title CAS commits and protects event snapshots', () => {
    const f = fixture()
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    expect(f.service.renameGenerated({ id: 'task-1', title: 'Generated', expectedRevision: 0 })).not.toBeNull()
    f.service.rename({ id: 'task-1', title: 'Generated' })
    expect(f.service.renameGenerated({ id: 'task-1', title: 'Late generated', expectedRevision: 1 })).toBeNull()
    expect(changes.map(event => [event.kind, event.titleSource, event.titleRevision])).toEqual([
      ['title', 'generated', 1],
      ['title', 'manual', 2],
    ])
    expect(Reflect.set(changes[0]!.conversation, 'title', 'External mutation')).toBe(false)
    expect(f.repository.getTitleState('task-1')).toMatchObject({ title: 'Generated', source: 'manual', revision: 2 })
    expect(f.repository.findById('task-1')?.updatedAt).toBe('2026-09-28T00:00:00.000Z')
  })

  it('keeps a committed permission change when its required invalidation fails and retries only application', async () => {
    const f = fixture()
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    f.invalidate.mockRejectedValueOnce(new Error('Session cleanup unavailable'))
    const input = { id: 'task-1', approvalPolicy: 'manual' as const, executionProfile: 'workspace_write' as const }
    await expect(f.service.setPermissionSettings(input)).rejects.toThrow('Session cleanup unavailable')
    expect(f.repository.findById('task-1')?.approvalPolicy).toBe('manual')
    expect(changes.map(event => event.kind)).toEqual(['permissions'])
    await expect(f.service.setPermissionSettings(input)).resolves.toMatchObject({ approvalPolicy: 'manual' })
    expect(changes).toHaveLength(1)
    expect(f.invalidate).toHaveBeenCalledTimes(2)
    await f.service.setPermissionSettings(input)
    expect(f.invalidate).toHaveBeenCalledTimes(2)
  })

  it('rechecks the captured task after model resolution without publishing a no-op', async () => {
    const f = fixture()
    const selection = { providerId: 'provider-1', modelId: 'model-1', reasoning: null, serviceTier: null }
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    expect(changes).toHaveLength(1)
    const gate = Promise.withResolvers<typeof selection>()
    f.resolveModel.mockImplementationOnce(() => gate.promise)
    const operation = f.service.setModelSelection({ id: 'task-1', modelSelection: { ...selection, modelId: 'model-2' } })
    f.repository.markDeleted('task-1', new Date().toISOString())
    gate.resolve({ ...selection, modelId: 'model-2' })
    await expect(operation).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.repository.findById('task-1')?.modelSelection?.modelId).toBe('model-1')
    expect(changes).toHaveLength(1)
  })
})

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const repository = createConversationRepository(database)
  repository.create({ id: 'task-1', branchId: 'branch-1', spaceId: null, title: 'Original', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-28T00:00:00.000Z' })
  database.prepare('UPDATE conversations SET title_source = ? WHERE id = ?').run('fallback', 'task-1')
  const invalidate = vi.fn(async (_id: string) => ({ pending: 0, degraded: 0 }))
  const resolveModel = vi.fn(async (selection: NonNullable<ReturnType<typeof repository.findById>>['modelSelection']) => selection!)
  const service = new ConversationMetadataService({ repository, resolveModelSelection: resolveModel, sessions: { invalidateConversation: invalidate } })
  return { service, repository, invalidate, resolveModel }
}
