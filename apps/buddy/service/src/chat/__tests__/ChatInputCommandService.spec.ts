import type { DatabaseSync } from 'node:sqlite'
import type { PreparedTurnAttachments } from '../persistPreparedTurn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ChatInputCommandService } from '../ChatInputCommandService'
import { ComposerDraftService } from '../ComposerDraftService'
import { PreparedRunCommandService } from '../PreparedRunCommandService'

const databases: DatabaseSync[] = []
const now = '2026-11-07T00:00:00.000Z'
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0))
    database.close()
})

function fixture() {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const repository = createComposerDraftRepository(database)
  repository.open({ draftId: 'draft', initialContent: createBuddyUserContent('Keep this input'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null, now, scope: { kind: 'global' } })
  const drafts = new ComposerDraftService(repository, async () => {})
  const admission = new CommandAdmissionService({ database, principal: createLocalCommandPrincipal(database), sourceInstanceId: 'instance' })
  const preparedRuns = new PreparedRunCommandService({ database, sourceInstanceId: 'instance' })
  const input = {
    dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation),
    expectedServiceInstanceId: 'instance',
    commandId: 'command',
    intent: { draftId: 'draft', expectedRevision: 0 },
  }
  const materials: PreparedTurnAttachments = { bindings: [], validate() {}, commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), retain: vi.fn(async () => {}) }
  let hold: Promise<void> | null = null
  let prepares = 0
  const prepareStart = async () => {
    prepares++
    await hold
    return { stagedAttachments: materials, prepared: {
      attachmentBindings: [],
      branchId: 'branch',
      conversationId: 'conversation',
      createdAt: now,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      draft: { draftId: 'draft', expectedRevision: 0 },
      model: 'fixture',
      spaceId: null,
      provider: 'fixture',
      runInput: { attachmentIds: [], contextItems: [], prompt: 'Keep this input', reasoning: null, serviceTier: null },
      runId: 'run',
      title: 'Input',
      userMessageContent: { text: 'Keep this input' },
      userMessageId: 'message',
      requestId: 'internal-request',
      requestFingerprint: 'internal-fingerprint',
    } }
  }
  const launched: string[] = []
  let launchError: Error | undefined
  const errors: unknown[] = []
  const service = new ChatInputCommandService({
    database,
    admission,
    drafts,
    preparedRuns,
    onDispatchError: error => errors.push(error),
    queue: {
      async prepareEnqueue() { throw new Error('Not used') },
      commitEnqueue() { throw new Error('Not used') },
      publishEnqueued() {},
    },
    compact: { prepare() { throw new Error('Not used') } },
    turns: {
      prepareStart,
      async prepareEdit() { throw new Error('Not used') },
      async prepareRegenerate() { throw new Error('Not used') },
      async launchAccepted(runId) {
        expect(database.isTransaction).toBe(false)
        expect(admission.lookup({ dataGeneration: input.dataGeneration, commandId: input.commandId }).lookup).toBe('decided')
        launched.push(runId)
        if (launchError)
          throw launchError
      },
    },
  })
  return { database, repository, drafts, admission, service, input, materials, launched, errors, failLaunch: (error: Error) => {
    launchError = error
  }, prepareCount: () => prepares, hold: (promise: Promise<void>) => {
    hold = promise
  } }
}

describe('chat input command admission', () => {
  it('retains acceptance and resource ownership when dispatch fails after commit', async () => {
    const f = fixture()
    const failure = new Error('execution owner unavailable')
    f.failLaunch(failure)
    const accepted = await f.service.execute('chat.startTurn', f.input)
    await f.service.waitForDispatches()
    expect(accepted.receipt.decision).toBe('accepted')
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run' }])
    expect(f.errors).toEqual([failure])
    expect(f.materials.commit).toHaveBeenCalledOnce()
    expect(f.materials.rollback).not.toHaveBeenCalled()
    expect(await f.service.execute('chat.startTurn', f.input)).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.launched).toEqual(['run'])
  })

  it('commits one target and launches once for concurrent requests and reply loss', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const first = f.service.execute('chat.startTurn', f.input)
    const second = f.service.execute('chat.startTurn', structuredClone(f.input))
    gate.resolve()
    const [accepted, replay] = await Promise.all([first, second])
    await f.service.waitForDispatches()
    expect(accepted.created).toBe(true)
    expect(replay).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.prepareCount()).toBe(1)
    expect(f.launched).toEqual(['run'])
    expect(f.database.prepare('SELECT count(*) AS count FROM run_events').get()).toEqual({ count: 1 })
    f.database.prepare('UPDATE runs SET status = \'failed\', error_code = \'SERVICE_INTERRUPTED\' WHERE id = \'run\'').run()
    f.database.prepare('DELETE FROM turn_requests WHERE draft_id = \'draft\'').run()
    f.database.prepare('DELETE FROM composer_drafts WHERE id = \'draft\'').run()
    expect(await f.service.execute('chat.startTurn', { ...f.input, expectedServiceInstanceId: 'old-instance' })).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.launched).toEqual(['run'])
  })

  it('keeps a draft save behind preparation and the acceptance transaction', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const accepted = f.service.execute('chat.startTurn', f.input)
    await vi.waitFor(() => expect(f.prepareCount()).toBe(1))
    const draft = f.repository.findById('draft')!
    const save = f.drafts.save({ draftId: 'draft', expectedRevision: 0, content: createBuddyUserContent('Later edit'), executionConfig: draft.executionConfig, modelSelection: draft.modelSelection })
    const saved = save.catch(error => error)
    gate.resolve()
    expect((await accepted).receipt.decision).toBe('accepted')
    expect(await saved).toMatchObject({ code: 'DRAFT_CONFLICT' })
    expect(f.repository.findById('draft')?.revision).toBe(1)
    await f.service.waitForDispatches()
  })

  it('records a stable rejection when the draft changes through another writer during preparation', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const result = f.service.execute('chat.startTurn', f.input)
    await vi.waitFor(() => expect(f.prepareCount()).toBe(1))
    const draft = f.repository.findById('draft')!
    f.repository.save({ draftId: 'draft', expectedRevision: 0, content: createBuddyUserContent('Changed'), executionConfig: draft.executionConfig, modelSelection: draft.modelSelection, now })
    gate.resolve()
    const rejected = await result
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    expect(f.database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(f.materials.rollback).toHaveBeenCalledOnce()
    expect(await f.service.execute('chat.startTurn', f.input)).toEqual({ created: false, receipt: rejected.receipt })
    expect(f.launched).toEqual([])
  })

  it.each(['chat.startTurn', 'chat.editUserMessage'] as const)('records a fixed rejection when %s refers to a deleted task', async (method) => {
    const f = fixture()
    await f.service.execute('chat.startTurn', f.input)
    await f.service.waitForDispatches()
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'run\'').run()
    const conversations = createConversationRepository(f.database)
    conversations.createBranch({ id: 'other-branch', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'message', createdAt: now, activate: true })
    f.repository.open({ draftId: 'stale-draft', initialContent: createBuddyUserContent('Keep the original source'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: null, now, scope: method === 'chat.editUserMessage'
      ? { kind: 'message_edit', conversationId: 'conversation', branchId: 'branch', userMessageId: 'message' }
      : { kind: 'conversation_branch', conversationId: 'conversation', branchId: 'branch' } })
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(now, 'conversation')
    const input = { ...f.input, commandId: 'stale-command', intent: { draftId: 'stale-draft', expectedRevision: 0, ...(method === 'chat.editUserMessage' ? { conversationId: 'conversation', userMessageId: 'message' } : {}) } }
    const result = await f.service.execute(method, input)
    expect(result.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
    expect(conversations.findById('conversation')?.activeBranchId).toBe('other-branch')
    expect(f.repository.findById('stale-draft')).toMatchObject({ revision: 0, content: createBuddyUserContent('Keep the original source') })
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
    f.database.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ?').run('conversation')
    expect(await f.service.execute(method, input)).toEqual({ created: false, receipt: result.receipt })
    expect(f.launched).toEqual(['run'])
  })

  it('retains prepared files after an uncertain commit and never dispatches from that connection', async () => {
    const f = fixture()
    const exec = f.database.exec.bind(f.database)
    vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw new Error('Lost commit acknowledgement')
    })
    await expect(f.service.execute('chat.startTurn', f.input)).rejects.toMatchObject({ code: 'COMMAND_RESULT_UNKNOWN' })
    expect(f.materials.retain).toHaveBeenCalledOnce()
    expect(f.materials.rollback).not.toHaveBeenCalled()
    expect(f.launched).toEqual([])
    expect(f.database.prepare('SELECT count(*) AS count FROM command_receipts').get()).toEqual({ count: 1 })
  })

  it('does not accept or launch after stop wins during materialization', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const result = f.service.execute('chat.startTurn', f.input)
    await vi.waitFor(() => expect(f.prepareCount()).toBe(1))
    f.admission.stopAccepting()
    gate.resolve()
    await expect(result).rejects.toMatchObject({ code: 'SERVICE_STOPPING' })
    expect(f.database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(f.materials.rollback).toHaveBeenCalledOnce()
    expect(f.launched).toEqual([])
  })
})
