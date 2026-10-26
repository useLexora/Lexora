import type { DatabaseSync } from 'node:sqlite'
import type { ConversationMetadataCommit } from '../ConversationMetadataService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createConversationMemberRepository } from '../../storage/conversationMemberRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { ConversationMetadataService } from '../ConversationMetadataService'
import { ConversationMutationGuard } from '../ConversationMutationGuard'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('conversation metadata ownership', () => {
  it('previews a directly mentioned actor model without joining them or changing the leader', () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Reviewer' })
    const selection = { providerId: 'fixture', modelId: 'review-model', reasoning: 'high' as const, serviceTier: null }
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: buddySettingsSchema.parse({ ...actor.settings, model: selection }) })
    expect(f.service.getModelControls('task-1', actor.id)).toEqual({ current: null, next: { actorId: actor.id, isMember: false, modelSelection: selection } })
    expect(f.members.find('task-1', actor.id)).toBeNull()
    expect(f.repository.findById('task-1')?.buddyId).toBe('default')
  })

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

  it('writes a pending model change to the captured actor after a protagonist switch', async () => {
    const f = fixture()
    const selection = { providerId: 'fixture', modelId: 'model-2', reasoning: null, serviceTier: null }
    const other = f.buddies.create({ name: 'Other' })
    f.service.addMember({ id: 'task-1', buddyId: other.id })
    f.service.setBuddy({ id: 'task-1', buddyId: other.id })
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    f.service.addMember({ id: 'task-1', buddyId: 'default' })
    f.service.setBuddy({ id: 'task-1', buddyId: 'default' })
    const gate = Promise.withResolvers<typeof selection>()
    f.resolveModel.mockImplementationOnce(() => gate.promise)
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    const operation = f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    f.service.addMember({ id: 'task-1', buddyId: other.id })
    f.service.setBuddy({ id: 'task-1', buddyId: other.id })
    gate.resolve(selection)
    await expect(operation).resolves.toMatchObject({ buddyId: other.id, modelSelection: selection })
    expect(f.members.find('task-1', 'default')?.modelSelection).toEqual(selection)
    expect(f.members.find('task-1', other.id)?.modelSelection).toEqual(selection)
    expect(changes.filter(event => event.kind === 'model').map(event => event.actorId)).toEqual(['default'])
  })

  it('keeps in-flight model changes on their owning actor and rejects a run that ends during validation', async () => {
    const f = fixture()
    f.database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (\'message-1\', \'task-1\', \'branch-1\', \'user\', \'{}\', \'2026-10-11T00:00:00.000Z\')').run()
    f.runs.create({ id: 'run-1', conversationId: 'task-1', branchId: 'branch-1', triggeringMessageId: 'message-1', provider: 'fixture', model: 'model-1', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: '2026-10-11T00:00:00.000Z' })
    const other = f.buddies.create({ name: 'Other' })
    f.service.addMember({ id: 'task-1', buddyId: other.id })
    f.service.setBuddy({ id: 'task-1', buddyId: other.id })
    const selection = { providerId: 'fixture', modelId: 'model-2', reasoning: null, serviceTier: null }
    const resolved = { ...selection, api: 'openai-completions', input: ['text'], fileInputMimeTypes: [], contextWindow: 128000, maxTokens: 4096 }
    f.resolveModel.mockResolvedValueOnce(resolved)
    await f.service.setModelSelection({ id: 'task-1', runId: 'run-1', modelSelection: selection })
    expect(f.members.find('task-1', 'default')?.modelSelection).toBeNull()
    expect(f.runs.findById('run-1')?.modelOverride).toEqual(selection)
    expect(f.members.find('task-1', other.id)?.modelSelection).toBeNull()
    const nextSelection = { ...selection, modelId: 'next-model' }
    await f.service.setModelSelection({ id: 'task-1', modelSelection: nextSelection })
    expect(f.service.getModelControls('task-1')).toEqual({ current: null, next: { actorId: other.id, isMember: true, modelSelection: nextSelection } })
    f.service.addMember({ id: 'task-1', buddyId: 'default' })
    f.service.setBuddy({ id: 'task-1', buddyId: 'default' })
    await f.service.setModelSelection({ id: 'task-1', modelSelection: nextSelection })
    expect(f.service.getModelControls('task-1')).toEqual({ current: { runId: 'run-1', actorId: 'default', modelSelection: nextSelection }, next: { actorId: 'default', isMember: true, modelSelection: nextSelection } })
    await expect(f.service.setModelSelection({ id: 'task-1', actorId: other.id, runId: 'run-1', modelSelection: selection })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const gate = Promise.withResolvers<typeof selection>()
    f.resolveModel.mockImplementationOnce(() => gate.promise)
    const pending = f.service.setModelSelection({ id: 'task-1', runId: 'run-1', modelSelection: { ...selection, modelId: 'model-3' } })
    f.runs.reconcileTerminal('run-1', 'completed', '2026-10-11T00:01:00.000Z', null)
    gate.resolve({ ...selection, modelId: 'model-3' })
    await expect(pending).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(f.members.find('task-1', 'default')?.modelSelection).toEqual(nextSelection)
    expect(f.runs.findById('run-1')?.modelOverride).toEqual(nextSelection)
  })

  it('applies the same member selection to an active run without rewriting its accepted model', async () => {
    const f = fixture()
    const selection = { providerId: 'fixture', modelId: 'model-2', reasoning: 'high' as const, serviceTier: 'priority' as const }
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    f.database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('message-1', 'task-1', 'branch-1', 'user', '{}', '2026-10-11T00:00:00.000Z')
    f.runs.create({ id: 'run-1', conversationId: 'task-1', branchId: 'branch-1', triggeringMessageId: 'message-1', provider: 'fixture', model: 'model-1', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: '2026-10-11T00:00:00.000Z' })
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    expect(f.runs.findById('run-1')).toMatchObject({ model: 'model-1', modelOverride: selection })
    expect(f.members.find('task-1', 'default')?.modelSelection).toEqual(selection)

    const later = { ...selection, modelId: 'model-3' }
    const gate = Promise.withResolvers<typeof later>()
    f.resolveModel.mockImplementationOnce(() => gate.promise)
    const pending = f.service.setModelSelection({ id: 'task-1', modelSelection: later })
    f.runs.reconcileTerminal('run-1', 'completed', '2026-10-11T00:01:00.000Z', null)
    gate.resolve(later)
    await pending
    expect(f.members.find('task-1', 'default')?.modelSelection).toEqual(later)
    expect(f.runs.findById('run-1')).toMatchObject({ status: 'completed', modelOverride: selection })
  })

  it('moves a space-less task into an active space once and releases its sessions', async () => {
    const f = fixture()
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).resolves.toMatchObject({ id: 'task-1', spaceId: 'space-1' })
    expect(f.repository.findById('task-1')?.spaceId).toBe('space-1')
    expect(changes.map(event => event.kind)).toEqual(['space'])
    expect(f.invalidate).toHaveBeenCalledWith('task-1')
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-2' })).rejects.toMatchObject({ code: 'CONVERSATION_SPACE_CONFLICT' })
    expect(f.repository.findById('task-1')?.spaceId).toBe('space-1')
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).resolves.toMatchObject({ spaceId: 'space-1' })
    expect(changes).toHaveLength(1)
  })

  it('refuses to move a task into a revoked space or while it has an active run', async () => {
    const f = fixture()
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'revoked' })).rejects.toMatchObject({ code: 'SPACE_UNAVAILABLE' })
    f.runs.create({ id: 'run-1', conversationId: 'task-1', branchId: 'branch-1', triggeringMessageId: 'message-1', provider: 'fixture', model: 'model-1', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: '2026-10-11T00:00:00.000Z' })
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' })
    expect(f.repository.findById('task-1')?.spaceId).toBeNull()
    expect(f.invalidate).not.toHaveBeenCalled()
  })

  it.each(['waiting', 'paused'])('keeps %s queue inputs unchanged and refuses to move across any branch', async (state) => {
    const f = fixture()
    f.database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at) VALUES ('queued', 'task-1', 'branch-1', 'request', 'fingerprint', '{"spaceId":null}', ?, 'now')`).run(state)
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).rejects.toMatchObject({ code: 'CONVERSATION_QUEUE_NOT_EMPTY' })
    expect(f.database.prepare('SELECT state, prepared_json FROM chat_queue').get()).toEqual({ state, prepared_json: '{"spaceId":null}' })
    expect(f.repository.findById('task-1')?.spaceId).toBeNull()
  })

  it('does not commit or publish a move when session cleanup fails and permits a safe retry', async () => {
    const f = fixture()
    const changes: ConversationMetadataCommit[] = []
    f.service.onDidCommit(event => changes.push(event))
    f.invalidate.mockRejectedValueOnce(new Error('Cleanup failed'))
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).rejects.toThrow('Cleanup failed')
    expect(f.repository.findById('task-1')?.spaceId).toBeNull()
    expect(changes).toEqual([])
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).resolves.toMatchObject({ spaceId: 'space-1' })
    expect(changes).toHaveLength(1)
  })

  it('holds the shared admission barrier until cleanup and revalidates a revoked target before committing', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<{ pending: number, degraded: number }>()
    f.invalidate.mockImplementationOnce(() => gate.promise)
    const pending = f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })
    expect(() => f.mutations.assertWritable('task-1')).toThrow(expect.objectContaining({ code: 'CONVERSATION_BUSY' }))
    expect(() => f.mutations.assertWritable('unrelated')).not.toThrow()
    f.database.prepare('UPDATE spaces SET revoked_at = ? WHERE id = ?').run('now', 'space-1')
    gate.resolve({ pending: 0, degraded: 0 })
    await expect(pending).rejects.toMatchObject({ code: 'SPACE_UNAVAILABLE' })
    expect(f.repository.findById('task-1')?.spaceId).toBeNull()
    expect(() => f.mutations.assertWritable('task-1')).not.toThrow()
  })

  it('refuses to switch while a terminal run still owns execution resources', async () => {
    const f = fixture()
    f.hasActiveExecution.mockReturnValueOnce(true)
    await expect(f.service.moveToSpace({ id: 'task-1', spaceId: 'space-1' })).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' })
    expect(f.repository.findById('task-1')?.spaceId).toBeNull()
  })

  it('revalidates a target disabled during model validation and records explicit provenance for an unchanged legacy value', async () => {
    const f = fixture()
    const other = f.buddies.create({ name: 'Other' })
    const selection = { providerId: 'fixture', modelId: 'model-1', reasoning: null, serviceTier: null }
    f.service.addMember({ id: 'task-1', buddyId: other.id })
    f.service.setBuddy({ id: 'task-1', buddyId: other.id })
    f.members.setModelSelection({ conversationId: 'task-1', actorId: other.id, modelSelection: selection, source: 'legacy', updatedAt: '2026-10-11T10:00:00.000Z' })
    await f.service.setModelSelection({ id: 'task-1', modelSelection: selection })
    expect(f.members.find('task-1', other.id)?.modelSelectionSource).toBe('explicit')
    const gate = Promise.withResolvers<typeof selection>()
    f.resolveModel.mockImplementationOnce(() => gate.promise)
    const operation = f.service.setModelSelection({ id: 'task-1', actorId: other.id, modelSelection: { ...selection, modelId: 'model-2' } })
    f.buddies.update({ buddyId: other.id, expectedRevision: other.revision, enabled: false })
    gate.resolve({ ...selection, modelId: 'model-2' })
    await expect(operation).rejects.toMatchObject({ code: 'BUDDY_DISABLED' })
    expect(f.members.find('task-1', other.id)?.modelSelection).toEqual(selection)
  })
})

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const repository = createConversationRepository(database)
  repository.create({ id: 'task-1', branchId: 'branch-1', spaceId: null, title: 'Original', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-28T00:00:00.000Z' })
  database.prepare('UPDATE conversations SET title_source = ?, title_revision = 0 WHERE id = ?').run('fallback', 'task-1')
  const invalidate = vi.fn(async (_id: string) => ({ pending: 0, degraded: 0 }))
  const resolveModel = vi.fn(async (selection: NonNullable<ReturnType<typeof repository.findById>>['modelSelection']) => selection!)
  const runs = createRunRepository(database)
  const buddies = createBuddyRepository(database)
  const seedSpace = database.prepare(`INSERT INTO spaces (id, name, memory_scope, revoked_at, created_at, updated_at) VALUES (?, ?, 'personal_and_space', ?, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')`)
  seedSpace.run('space-1', 'Space 1', null)
  seedSpace.run('space-2', 'Space 2', null)
  seedSpace.run('revoked', 'Revoked', '2026-09-07T00:00:00.000Z')
  const mutations = new ConversationMutationGuard()
  const hasActiveExecution = vi.fn(() => false)
  const service = new ConversationMetadataService({ buddies, runs, repository, spaces: createSpaceRepository(database), spaceMoves: { mutations, hasPendingMessages: id => createChatQueueRepository(database).hasPending(id), hasActiveExecution, validateTarget: async () => {} }, resolveModelSelection: resolveModel, sessions: { invalidateConversation: invalidate } })
  return { database, runs, service, repository, invalidate, mutations, hasActiveExecution, resolveModel, buddies, members: createConversationMemberRepository(database) }
}
