import type { DatabaseSync } from 'node:sqlite'
import type { ConversationModelSelection } from '../../storage/conversationRecord'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { projectCommandReceipt } from '../../productProtocol/projectCommandReceipt'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { ConversationCommandRepository } from '../../storage/ConversationCommandRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationHistoryStore } from '../../storage/conversationHistoryRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { createTaskMarkRepository } from '../../storage/taskMarkRepository'
import { ConversationCommandService } from '../ConversationCommandService'
import { ConversationLifecycleService } from '../ConversationLifecycleService'
import { ConversationMetadataService } from '../ConversationMetadataService'
import { ConversationMutationGuard } from '../ConversationMutationGuard'
import { TaskMarkService } from '../TaskMarkService'

const fixtures: Array<{ database: DatabaseSync, admission: CommandAdmissionService, commands: ConversationCommandService, metadata: ConversationMetadataService, lifecycle: ConversationLifecycleService, marks: TaskMarkService }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.admission.dispose()
    await f.commands.dispose()
    await f.metadata.dispose()
    await f.lifecycle.dispose()
    f.marks.dispose()
    f.database.close()
  }
})
const now = '2026-11-07T00:00:00.000Z'
const selection: ConversationModelSelection = { providerId: 'fixture', modelId: 'next-model', reasoning: null, serviceTier: null }

function fixture() {
  const database: DatabaseSync = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const conversations = createConversationRepository(database)
  conversations.create({ id: 'task', branchId: 'branch', spaceId: null, title: 'Initial', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  database.exec('UPDATE conversations SET title_source = \'fallback\', title_revision = 0 WHERE id = \'task\'')
  const repository = new ConversationCommandRepository(database)
  const runs = createRunRepository(database)
  const markRepository = createTaskMarkRepository(database)
  const principal = createLocalCommandPrincipal(database)
  const admission = new CommandAdmissionService({ database, principal, sourceInstanceId: 'instance' })
  const resolveModelSelection = vi.fn(async (input: ConversationModelSelection) => input)
  const invalidate = vi.fn(async () => ({ pending: 0, degraded: 0 }))
  const refresh = vi.fn()
  const effects: unknown[] = []
  const spaces = createSpaceRepository(database)
  const mutations = new ConversationMutationGuard()
  const metadata = new ConversationMetadataService({ database, spaces, spaceMoves: { mutations, hasPendingMessages: () => false, hasActiveExecution: () => false, validateTarget: async () => {} }, repository: conversations, buddies: createBuddyRepository(database), runs, runInputs: createRunInputRepository(database), resolveModelSelection, sessions: { invalidateConversation: invalidate, refreshModelSelection: refresh }, onObserverError: error => effects.push(error) })
  const marks = new TaskMarkService(markRepository, error => effects.push(error), database)
  const cancel = vi.fn(async () => 0)
  const lifecycle = new ConversationLifecycleService({ conversations, deletion: createConversationDeletionRepository(database), runner: { cancelAndWaitForConversation: cancel }, cancelQueuedRuns: async () => {}, sessions: { invalidateConversation: invalidate } })
  const commands = new ConversationCommandService({ database, admission, repository, metadata, lifecycle, marks, onEffectError: error => effects.push(error) })
  const command = (commandId: string, intent: unknown) => ({ commandId, intent, expectedServiceInstanceId: 'instance', dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation) })
  const f = { database, spaces, mutations, conversations, repository, runs, admission, resolveModelSelection, invalidate, refresh, metadata, marks, markRepository, lifecycle, cancel, commands, command, effects }
  fixtures.push(f)
  return f
}

describe('conditional task metadata commands', () => {
  it('protects manual titles with their independent revision and publishes only after the receipt commits', async () => {
    const f = fixture()
    const metadataRevision = f.repository.conversationRevision('task')
    f.metadata.renameGenerated({ id: 'task', title: 'Generated', expectedRevision: 0 })
    expect(f.repository.conversationRevision('task')).toBe(metadataRevision)
    const observed: string[] = []
    f.metadata.onDidCommit((event) => {
      expect(f.database.isTransaction).toBe(false)
      expect(f.database.prepare('SELECT count(*) AS count FROM command_receipts').get()?.count).toBeGreaterThan(0)
      observed.push(event.kind)
    })
    const rejected = await f.commands.execute('conversations.rename', f.command('stale-title', { conversationId: 'task', title: 'Old edit', expectedTitleRevision: 0 }))
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    const request = f.command('manual-title', { conversationId: 'task', title: 'My title', expectedTitleRevision: 1 })
    const accepted = await f.commands.execute('conversations.rename', request)
    expect(accepted.receipt).toMatchObject({ decision: 'accepted', result: { titleRevision: 2 } })
    expect(observed).toEqual(['title'])
    expect(f.metadata.renameGenerated({ id: 'task', title: 'Late generated', expectedRevision: 2 })).toBeNull()
    expect(f.conversations.findById('task')).toMatchObject({ title: 'My title', updatedAt: now })
    expect(f.repository.conversationRevision('task')).toBe(metadataRevision)
    expect(await f.commands.execute('conversations.rename', request)).toEqual({ created: false, receipt: accepted.receipt })
  })

  it('persists the exact activated branch in receipts and replays it without switching a later selection', async () => {
    const f = fixture()
    const history = createConversationHistoryStore(f.database).repository
    history.createMessage({ id: 'fork-point', conversationId: 'task', branchId: 'branch', runId: null, role: 'user', content: { text: 'Original input' }, createdAt: now })
    history.createBranch({ id: 'fork', conversationId: 'task', parentBranchId: 'branch', forkedFromMessageId: 'fork-point', activate: false, createdAt: now })
    const revision = f.repository.conversationRevision('task')
    const request = f.command('activate-fork', { conversationId: 'task', branchId: 'fork', expectedRevision: revision })
    const accepted = await f.commands.execute('conversations.activateBranch', request)
    expect(accepted.receipt).toMatchObject({ decision: 'accepted', target: { conversationId: 'task', branchId: 'fork' } })
    expect(projectCommandReceipt(accepted.receipt).target).toEqual({ conversationId: 'task', branchId: 'fork' })
    expect(f.conversations.findById('task')?.activeBranchId).toBe('fork')
    const restored = await f.commands.execute('conversations.activateBranch', f.command('restore-original', { conversationId: 'task', branchId: 'branch', expectedRevision: f.repository.conversationRevision('task') }))
    expect(restored.receipt).toMatchObject({ decision: 'accepted', target: { conversationId: 'task', branchId: 'branch' } })
    expect(f.admission.lookup({ dataGeneration: request.dataGeneration, commandId: request.commandId })).toEqual({ lookup: 'decided', receipt: accepted.receipt })
    expect(await f.commands.execute('conversations.activateBranch', request)).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.conversations.findById('task')?.activeBranchId).toBe('branch')
    const stale = await f.commands.execute('conversations.activateBranch', f.command('stale-fork', { conversationId: 'task', branchId: 'fork', expectedRevision: revision }))
    expect(stale.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')?.activeBranchId).toBe('branch')
  })

  it('rejects a model choice whose metadata revision changed while resolving its model', async () => {
    const f = fixture()
    const revision = f.repository.conversationRevision('task')
    const gate = Promise.withResolvers<ConversationModelSelection>()
    f.resolveModelSelection.mockReturnValueOnce(gate.promise)
    const request = f.command('model', { conversationId: 'task', expectedRevision: revision, expectedActiveRun: null, modelSelection: selection })
    const model = f.commands.execute('conversations.setModelSelection', request)
    await vi.waitFor(() => expect(f.resolveModelSelection).toHaveBeenCalled())
    f.invalidate.mockImplementationOnce(async () => {
      expect(f.database.isTransaction).toBe(false)
      expect(f.admission.lookup({ dataGeneration: request.dataGeneration, commandId: 'permissions' }).lookup).toBe('decided')
      return { pending: 0, degraded: 0 }
    })
    const permission = await f.commands.execute('conversations.setPermissionSettings', f.command('permissions', { conversationId: 'task', expectedRevision: revision, approvalPolicy: 'manual', executionProfile: 'workspace_write' }))
    expect(permission.receipt.decision).toBe('accepted')
    gate.resolve(selection)
    const rejected = await model
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')).toMatchObject({ approvalPolicy: 'manual', modelSelection: null })
    expect(await f.commands.execute('conversations.setModelSelection', request)).toEqual({ created: false, receipt: rejected.receipt })
  })

  it('rejects an actor model change if a run starts during asynchronous preparation', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<ConversationModelSelection>()
    f.resolveModelSelection.mockReturnValueOnce(gate.promise)
    const request = f.command('new-active-run', { conversationId: 'task', actorId: 'default', expectedRevision: f.repository.conversationRevision('task'), expectedActiveRun: null, modelSelection: selection })
    const pending = f.commands.execute('conversations.setModelSelection', request)
    await vi.waitFor(() => expect(f.resolveModelSelection).toHaveBeenCalled())
    seedRun(f)
    gate.resolve(selection)
    const rejected = await pending
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')?.modelSelection).toBeNull()
    expect(f.runs.findById('run')?.modelOverride).toBeNull()
    expect(await f.commands.execute('conversations.setModelSelection', request)).toEqual({ created: false, receipt: rejected.receipt })
  })

  it('projects candidate read versions and atomically protects both actor and live model choices', async () => {
    const f = fixture()
    seedRun(f)
    const controls = f.metadata.getModelControls('task', 'default')
    expect(controls).toMatchObject({ metadataRevision: f.repository.conversationRevision('task'), current: { runId: 'run', generation: 0 } })
    expect(f.conversations.listRecent(10)[0]).toMatchObject({ metadataRevision: controls.metadataRevision, titleRevision: 0 })
    expect(f.metadata.listMembers('task')[0]).toMatchObject({ metadataRevision: controls.metadataRevision })
    const request = f.command('actor-and-live-model', { conversationId: 'task', actorId: 'default', expectedRevision: controls.metadataRevision, expectedActiveRun: { runId: controls.current!.runId, generation: controls.current!.generation, modelSelection: controls.current!.modelSelection }, modelSelection: selection })
    f.runs.setModelSelection('run', { ...selection, modelId: 'changed-elsewhere' })
    expect((await f.commands.execute('conversations.setModelSelection', request)).receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.conversations.findById('task')?.modelSelection).toBeNull()
    const fresh = f.metadata.getModelControls('task', 'default')
    const accepted = await f.commands.execute('conversations.setModelSelection', f.command('fresh-actor-and-live-model', { conversationId: 'task', actorId: 'default', expectedRevision: fresh.metadataRevision, modelSelection: selection, expectedActiveRun: { runId: fresh.current!.runId, generation: fresh.current!.generation, modelSelection: fresh.current!.modelSelection } }))
    expect(accepted.receipt.decision).toBe('accepted')
    expect(f.conversations.findById('task')?.modelSelection).toEqual(selection)
    expect(f.runs.findById('run')).toMatchObject({ model: 'accepted-model', modelOverride: selection })
  })

  it('keeps read and mark assignment revisions independent and refuses stale clear or read', async () => {
    const f = fixture()
    const first = await f.commands.execute('taskMarks.create', f.command('new-mark', { name: 'First', description: '', color: '#3979d6' }))
    const markId = String(first.receipt.target.markId)
    await f.commands.execute('taskMarks.assign', f.command('assign', { conversationId: 'task', markId, expectedAssignmentRevision: 0 }))
    expect(f.repository.assignmentRevision('task')).toBe(1)
    const staleClear = await f.commands.execute('taskMarks.clear', f.command('stale-clear', { conversationId: 'task', expectedAssignmentRevision: 0, readRevision: 0, resultRunId: null }))
    expect(staleClear.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    await f.commands.execute('taskMarks.setRead', f.command('unread', { conversationId: 'task', readRevision: 0, resultRunId: null, read: false }))
    expect(f.repository.assignmentRevision('task')).toBe(1)
    const staleRead = await f.commands.execute('taskMarks.setRead', f.command('stale-read', { conversationId: 'task', readRevision: 0, resultRunId: null, read: true }))
    expect(staleRead.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(f.markRepository.getState('task')).toMatchObject({ markId, readRevision: 1, unread: true })
    await f.commands.execute('taskMarks.clear', f.command('clear', { conversationId: 'task', expectedAssignmentRevision: 1, readRevision: 1, resultRunId: null }))
    expect(f.markRepository.getState('task')).toMatchObject({ markId: null, readRevision: 2, unread: false })
    expect(f.repository.assignmentRevision('task')).toBe(2)
  })

  it('fixes the tombstone receipt before cleanup and replays it without resurrecting the task', async () => {
    const f = fixture()
    const request = f.command('delete', { conversationId: 'task', expectedRevision: f.repository.conversationRevision('task') })
    f.cancel.mockImplementationOnce(async () => {
      expect(f.database.isTransaction).toBe(false)
      expect(f.conversations.findById('task')?.deletedAt).toBeTypeOf('string')
      expect(f.admission.lookup({ dataGeneration: request.dataGeneration, commandId: request.commandId }).lookup).toBe('decided')
      throw new Error('Cleanup pending')
    })
    const accepted = await f.commands.execute('conversations.delete', request)
    await f.commands.dispose()
    expect(accepted.receipt).toMatchObject({ decision: 'accepted', result: { cleanup: 'pending' } })
    expect(f.effects).toHaveLength(1)
    expect(await f.commands.execute('conversations.delete', request)).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.database.prepare('SELECT count(*) AS count FROM conversations WHERE id = \'task\'').get()).toEqual({ count: 1 })
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })

  it('holds the task mutation guard until committed space selection finishes releasing its session', async () => {
    const f = fixture()
    f.spaces.create({ id: 'space', name: 'Workspace', createdAt: now, memoryScope: 'space_only', additionalDirectories: [], primaryDirectory: { id: 'directory', root: '/fixture/workspace', canonicalRoot: '/fixture/workspace', accessGrantedAt: now, resourcesTrustedAt: now } })
    const release = Promise.withResolvers<{ pending: number, degraded: number }>()
    f.invalidate.mockReturnValueOnce(release.promise)
    const request = f.command('move', { conversationId: 'task', spaceId: 'space', expectedRevision: f.repository.conversationRevision('task') })
    const moving = f.commands.execute('conversations.moveToSpace', request)
    await vi.waitFor(() => expect(f.invalidate).toHaveBeenCalled())
    expect(f.conversations.findById('task')?.spaceId).toBe('space')
    expect(f.admission.lookup({ dataGeneration: request.dataGeneration, commandId: request.commandId }).lookup).toBe('decided')
    expect(() => f.mutations.assertWritable('task')).toThrow()
    release.resolve({ pending: 0, degraded: 0 })
    expect((await moving).receipt.decision).toBe('accepted')
    expect(() => f.mutations.assertWritable('task')).not.toThrow()
  })

  it('rolls back metadata and suppresses notifications when receipt insertion fails', async () => {
    const f = fixture()
    f.database.exec('CREATE TRIGGER reject_metadata_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, \'receipt unavailable\'); END')
    const changes: unknown[] = []
    f.metadata.onDidCommit(event => changes.push(event))
    await expect(f.commands.execute('conversations.rename', f.command('failed-title', { conversationId: 'task', title: 'Cannot commit', expectedTitleRevision: 0 }))).rejects.toThrow('receipt unavailable')
    expect(f.conversations.findById('task')?.title).toBe('Initial')
    expect(f.repository.conversationRevision('task', true)).toBe(0)
    expect(changes).toEqual([])
  })
})

function seedRun(f: ReturnType<typeof fixture>) {
  f.database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (\'message\', \'task\', \'branch\', \'user\', \'{}\', ?)').run(now)
  f.runs.create({ id: 'run', conversationId: 'task', branchId: 'branch', triggeringMessageId: 'message', provider: 'fixture', model: 'accepted-model', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: now })
}
