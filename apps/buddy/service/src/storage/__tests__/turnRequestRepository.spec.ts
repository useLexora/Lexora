import type { DatabaseSync } from 'node:sqlite'
import type { TurnRequestCommit } from '../../chat/TurnRequestService'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { TurnRequestService } from '../../chat/TurnRequestService'
import { createAttachmentRepository } from '../attachmentRepository'

import { ComposerDraftCommitConflictError } from '../commitComposerDraft'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import {
  createTurnRequestRepository,
  TurnRequestConflictError,
} from '../turnRequestRepository'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('turnRequestRepository', () => {
  it('commits message attachment ownership in the same batch and exposes no staged paths', () => {
    const database = createDatabase()
    const attachments = createAttachmentRepository(database)
    attachments.create({ id: 'owned-attachment', conversationId: null, draftId: 'draft-1', messageId: null, name: 'private-name.txt', mimeType: 'text/plain', sizeBytes: 1, storedPath: '/private/source.txt', createdAt: '2026-08-14T00:00:00.000Z' })
    const input = createInput()
    const prepared = { ...input, runInput: { ...input.runInput, attachmentIds: ['owned-attachment'] }, attachmentBindings: [{ id: 'owned-attachment', sourceAttachmentId: 'owned-attachment', sourceDraftId: 'draft-1', messageId: input.userMessageId, storedPath: '/private/destination.txt', createdAt: input.createdAt }] }
    const service = new TurnRequestService(createTurnRequestRepository(database))
    const events: TurnRequestCommit[] = []
    service.onDidCommit(event => events.push(event))
    expect(() => service.prepare({ ...prepared, draft: { draftId: 'draft-1', expectedRevision: 99 } })).toThrow(ComposerDraftCommitConflictError)
    expect(events).toEqual([])
    expect(attachments.findById('owned-attachment')).toMatchObject({ draftId: 'draft-1', messageId: null })
    service.prepare(prepared)
    expect(attachments.findById('owned-attachment')).toMatchObject({ draftId: null, messageId: input.userMessageId, conversationId: input.conversationId })
    expect(events[0]!.facts.find(fact => fact.kind === 'attachments.bound')).toEqual({ kind: 'attachments.bound', messageId: input.userMessageId, attachmentIds: ['owned-attachment'] })
    expect(JSON.stringify(events)).not.toMatch(/private-name|\/private\//)
    service.dispose()
  })

  it('publishes one frozen transaction batch and no facts for rollback or request replay', () => {
    const database = createDatabase()
    const service = new TurnRequestService(createTurnRequestRepository(database))
    const events: TurnRequestCommit[] = []
    service.onDidCommit(event => events.push(event))
    const input = createInput()
    expect(() => service.prepare({ ...input, draft: { draftId: 'draft-1', expectedRevision: 99 } })).toThrow(ComposerDraftCommitConflictError)
    expect(events).toEqual([])
    const result = service.prepare(input)
    expect(events[0]).toMatchObject({ commitId: result.runId, requestId: result.requestId, conversationId: result.conversationId, branchId: result.branchId })
    expect(events[0]!.facts.map(fact => fact.kind)).toEqual(['task.created', 'branch.created', 'task.branch_activated', 'task.model_changed', 'message.created', 'run.queued', 'draft.consumed'])
    const consumed = events[0]!.facts.find(fact => fact.kind === 'draft.consumed')!
    expect(Reflect.set(consumed.receipt, 'committedRevision', 9)).toBe(false)
    expect(service.prepare(input)).toMatchObject({ created: false, draftReceipt: { committedRevision: 1 } })
    expect(events).toHaveLength(1)
    service.dispose()
  })

  it('publishes only a new run for interrupted request retry without consuming its previous draft again', () => {
    const database = createDatabase()
    const service = new TurnRequestService(createTurnRequestRepository(database))
    const events: TurnRequestCommit[] = []
    service.onDidCommit(event => events.push(event))
    service.prepare(createInput())
    database.prepare('UPDATE runs SET status = \'failed\', error_code = \'RUNTIME_RESTARTED\', completed_at = ? WHERE id = ?').run('2026-08-14T00:00:01.000Z', 'run-1')
    service.retryInterrupted({ requestId: 'request-1', runId: 'run-2', createdAt: '2026-08-14T00:00:02.000Z' })
    service.retryInterrupted({ requestId: 'request-1', runId: 'unused', createdAt: '2026-08-14T00:00:03.000Z' })
    expect(events.map(event => event.commitId)).toEqual(['run-1', 'run-2'])
    expect(events[1]!.facts).toEqual([{ kind: 'request.retried', previousRunId: 'run-1' }, { kind: 'run.queued' }])
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    service.dispose()
  })

  it('narrows only the run profile and rejects wider overrides without consuming the draft', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    const drafts = createComposerDraftRepository(database)
    const original = drafts.findById('draft-1')
    expect(() => repository.prepare({ ...createInput(), runExecutionProfile: 'full_access' })).toThrow(TurnRequestConflictError)
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(drafts.findById('draft-1')).toEqual(original)

    repository.prepare({ ...createInput(), runExecutionProfile: 'read_only' })
    expect(database.prepare('SELECT execution_profile FROM runs').get()).toEqual({ execution_profile: 'read_only' })
    expect(database.prepare('SELECT execution_profile FROM conversations').get()).toEqual({ execution_profile: 'workspace_write' })
    expect(drafts.findById('draft-1')).toMatchObject({ revision: 1, executionConfig: { executionProfile: 'workspace_write' } })
  })

  it('creates a followup branch only when its source and draft commit succeed, preserving the original draft', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.exec(`
      UPDATE runs SET status = 'completed' WHERE id = 'run-1';
      INSERT INTO messages VALUES ('answer-1', 'conversation-1', 'branch-1', 'run-1', 'assistant', '{"text":"answer"}', '2026-08-14T00:00:01.000Z');
    `)
    const drafts = createComposerDraftRepository(database)
    const original = drafts.findById('draft-1')
    expect(drafts.discard({ draftId: 'draft-1', expectedRevision: original!.revision })).toBe(false)
    expect(drafts.findById('draft-1')).toEqual(original)
    drafts.open({
      ...createDraftInput(),
      draftId: 'followup-draft',
      scope: { kind: 'message_followup', conversationId: 'conversation-1', branchId: 'branch-1', assistantMessageId: 'answer-1' },
    })
    const followup = {
      ...createInput(),
      requestId: 'followup-request',
      runId: 'run-followup',
      branchId: 'branch-followup',
      userMessageId: 'question-followup',
      createdAt: '2026-08-14T00:00:02.000Z',
      draft: { draftId: 'followup-draft', expectedRevision: 0 },
      followup: { parentBranchId: 'branch-1', sourceRunId: 'run-1', sourceMessageId: 'answer-1' },
    }
    expect(() => repository.prepare({ ...followup, draft: { ...followup.draft, expectedRevision: 1 } }))
      .toThrow(ComposerDraftCommitConflictError)
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversation_branches').get()).toEqual({ count: 1 })
    expect(repository.prepare(followup)).toMatchObject({ created: true, branchId: 'branch-followup' })
    expect(repository.prepare(followup)).toMatchObject({ created: false, branchId: 'branch-followup' })
    expect(database.prepare('SELECT * FROM run_tree_sources WHERE run_id = ?').get('run-followup'))
      .toEqual({ run_id: 'run-followup', source_run_id: 'run-1', position: 'after' })
    expect(drafts.findById('draft-1')).toEqual(original)
    expect(drafts.findById('followup-draft')?.scope)
      .toEqual({ kind: 'conversation_branch', conversationId: 'conversation-1', branchId: 'branch-followup' })
    expect(createConversationRepository(database).listBranchMessages('conversation-1', 'branch-followup').map(message => message.id))
      .toEqual(['message-1', 'answer-1', 'question-followup'])
  })

  it.each(['failed', 'cancelled'] as const)('retries a %s answer on a separate branch while preserving its input and history', (status) => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, 'run-1')
    const input = {
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      branchId: 'branch-retry',
      parentBranchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:02.000Z',
      forkedFromMessageId: 'message-1',
      requestFingerprint: 'retry',
      requestId: 'retry',
      runId: 'run-retry',
      sourceRunId: 'run-1',
    }
    expect(repository.regenerate(input)).toMatchObject({ created: true, branchId: 'branch-retry' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversation_branches').get()).toEqual({ count: 2 })
    expect(database.prepare('SELECT * FROM run_tree_sources WHERE run_id = ?').get('run-retry'))
      .toEqual({ run_id: 'run-retry', source_run_id: 'run-1', position: 'before' })
    expect(repository.regenerate(input)).toMatchObject({ created: false, branchId: 'branch-retry', runId: 'run-retry' })
    expect(database.prepare('SELECT status FROM runs WHERE id = ?').get('run-1')).toEqual({ status })
    expect(database.prepare('SELECT triggering_message_id FROM runs WHERE id = ?').get('run-retry'))
      .toEqual({ triggering_message_id: 'message-1' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(createConversationRepository(database).listBranchMessages('conversation-1', 'branch-retry').map(message => message.id))
      .toEqual(['message-1'])
  })

  it('commits one draft and preserves newer edits across idempotent retries', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    const input = createInput()
    const drafts = createComposerDraftRepository(database)

    expect(repository.prepare(input)).toMatchObject({
      created: true,
      draftReceipt: {
        committedRevision: 1,
        draftId: 'draft-1',
        sourceRevision: 0,
      },
      runId: 'run-1',
    })
    expect(repository.prepare(input)).toMatchObject({
      created: false,
      draftReceipt: {
        committedRevision: 1,
        draftId: 'draft-1',
        sourceRevision: 0,
      },
      runId: 'run-1',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
    expect(database.prepare(`
      SELECT context_window, max_tokens FROM runs WHERE id = ?
    `).get('run-1')).toEqual({ context_window: 200_000, max_tokens: 32_000 })
    expect(database.prepare('SELECT * FROM run_inputs WHERE run_id = ?').get('run-1'))
      .toMatchObject({
        attachment_ids_json: '[]',
        context_items_json: '[{"kind":"file","value":"notes.md"}]',
        prompt: 'Materialized Hello',
        reasoning: 'high',
        service_tier: null,
      })
    expect(createConversationRepository(database).findById('conversation-1')?.modelSelection)
      .toEqual({
        modelId: 'claude-sonnet-4-5',
        providerId: 'anthropic',
        reasoning: 'high',
        serviceTier: null,
      })
    expect(drafts.findById('draft-1')).toMatchObject({
      content: createBuddyUserContent(),
      revision: 1,
      scope: { branchId: 'branch-1', conversationId: 'conversation-1', kind: 'conversation_branch' },
    })
    const newer = drafts.save({
      content: createBuddyUserContent('Newer input'),
      draftId: 'draft-1',
      executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      expectedRevision: 1,
      modelSelection: { modelId: 'claude-sonnet-4-5', providerId: 'anthropic', reasoning: 'high', serviceTier: null },
      now: '2026-08-14T00:00:02.000Z',
    })
    expect(repository.prepare(input)).toMatchObject({ created: false })
    expect(drafts.findById('draft-1')).toEqual(newer)
    expect(() => repository.prepare({ ...input, requestFingerprint: 'different' })).toThrow(TurnRequestConflictError)
  })

  it('rolls back the message, run and conversation when the draft revision conflicts', () => {
    const database = createDatabase()
    const drafts = createComposerDraftRepository(database)
    const repository = createTurnRequestRepository(database)

    expect(() => repository.prepare({
      ...createInput(),
      draft: { draftId: 'draft-1', expectedRevision: 3 },
    })).toThrow(ComposerDraftCommitConflictError)
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(drafts.findById('draft-1')).toMatchObject({ revision: 0, scope: { kind: 'global' } })
  })

  it('rejects a second turn while the conversation already has an incomplete run', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    const first = createInput()
    repository.prepare(first)

    expect(repository.prepare(first)).toMatchObject({ created: false, runId: 'run-1' })
    expect(() => repository.prepare({
      ...first,
      requestFingerprint: 'fingerprint-2',
      requestId: 'request-2',
      runId: 'run-2',
      userMessageId: 'message-2',
    })).toThrow(TurnRequestConflictError)
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
  })

  it('persists an explicit conversation model choice before the next turn', () => {
    const database = createDatabase()
    createTurnRequestRepository(database).prepare(createInput())
    const conversations = createConversationRepository(database)

    expect(conversations.setModelSelection({
      id: 'conversation-1',
      modelSelection: {
        modelId: 'gpt-5.6',
        providerId: 'openai-codex',
        reasoning: 'max',
        serviceTier: 'priority',
      },
      updatedAt: '2026-08-14T00:00:01.000Z',
    })?.modelSelection).toEqual({
      modelId: 'gpt-5.6',
      providerId: 'openai-codex',
      reasoning: 'max',
      serviceTier: 'priority',
    })
  })

  it('atomically replaces an interrupted run without duplicating the user message', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare(`
      UPDATE runs
      SET status = 'failed', error_code = 'RUNTIME_RESTARTED', completed_at = ?
      WHERE id = 'run-1'
    `).run('2026-08-14T00:00:01.000Z')

    expect(repository.retryInterrupted({
      createdAt: '2026-08-14T00:00:02.000Z',
      requestId: 'request-1',
      runId: 'run-2',
    })).toMatchObject({ created: true, runId: 'run-2' })
    expect(repository.retryInterrupted({
      createdAt: '2026-08-14T00:00:03.000Z',
      requestId: 'request-1',
      runId: 'run-3',
    })).toMatchObject({ created: false, runId: 'run-2' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 })
    expect(database.prepare(`
      SELECT run_id, prompt, attachment_ids_json, context_items_json, reasoning, service_tier
      FROM run_inputs ORDER BY run_id
    `).all()).toEqual([
      {
        attachment_ids_json: '[]',
        context_items_json: '[{"kind":"file","value":"notes.md"}]',
        prompt: 'Materialized Hello',
        reasoning: 'high',
        run_id: 'run-1',
        service_tier: null,
      },
      {
        attachment_ids_json: '[]',
        context_items_json: '[{"kind":"file","value":"notes.md"}]',
        prompt: 'Materialized Hello',
        reasoning: 'high',
        run_id: 'run-2',
        service_tier: null,
      },
    ])
  })

  it('rejects retrying an interrupted request while another run is incomplete', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare(`
      UPDATE runs
      SET status = 'failed', error_code = 'RUNTIME_RESTARTED', completed_at = ?
      WHERE id = 'run-1'
    `).run('2026-08-14T00:00:01.000Z')
    database.exec(`
      INSERT INTO runs (
        id, conversation_id, branch_id, triggering_message_id, provider, model,
        context_window, max_tokens, purpose, status, pi_session_file, error_code,
        started_at, completed_at, execution_profile
      )
      SELECT
        'run-other', conversation_id, branch_id, triggering_message_id, provider, model,
        context_window, max_tokens, purpose, 'queued', pi_session_file, NULL,
        '2026-08-14T00:00:02.000Z', NULL, execution_profile
      FROM runs WHERE id = 'run-1'
    `)

    expect(() => repository.retryInterrupted({
      createdAt: '2026-08-14T00:00:03.000Z',
      requestId: 'request-1',
      runId: 'run-2',
    })).toThrow(TurnRequestConflictError)
  })

  it('rejects new and interrupted turns after conversation deletion is requested', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare(`
      UPDATE runs
      SET status = 'failed', error_code = 'RUNTIME_RESTARTED', completed_at = ?
      WHERE id = 'run-1'
    `).run('2026-08-14T00:00:01.000Z')
    database.prepare(`
      UPDATE conversations SET deleted_at = '2026-08-14T00:00:02.000Z'
      WHERE id = 'conversation-1'
    `).run()

    expect(() => repository.prepare({
      ...createInput(),
      requestId: 'request-2',
      runId: 'run-2',
      userMessageId: 'message-2',
    })).toThrow(TurnRequestConflictError)
    expect(() => repository.retryInterrupted({
      createdAt: '2026-08-14T00:00:03.000Z',
      requestId: 'request-1',
      runId: 'run-3',
    })).toThrow(TurnRequestConflictError)
  })

  it('atomically regenerates from the original user input without duplicating its message', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare(`
      UPDATE runs SET status = 'completed', completed_at = ? WHERE id = 'run-1'
    `).run('2026-08-14T00:00:01.000Z')
    createConversationRepository(database).createMessage({
      branchId: 'branch-1',
      content: { text: 'First answer' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      id: 'assistant-1',
      role: 'assistant',
      runId: 'run-1',
    })
    const regeneration = {
      branchId: 'branch-2',
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:02.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      forkedFromMessageId: 'message-1',
      parentBranchId: 'branch-1',
      requestFingerprint: 'regenerate-fingerprint-1',
      requestId: 'regenerate-request-1',
      runId: 'run-2',
      sourceRunId: 'run-1',
    }

    expect(repository.regenerate(regeneration)).toMatchObject({
      branchId: 'branch-2',
      created: true,
      runId: 'run-2',
    })
    expect(repository.regenerate({ ...regeneration, runId: 'run-3' })).toMatchObject({
      branchId: 'branch-2',
      created: false,
      runId: 'run-2',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM run_inputs').get()).toEqual({ count: 2 })
    expect(createConversationRepository(database)
      .listBranchMessages('conversation-1', 'branch-2')
      .map(message => message.id)).toEqual(['message-1'])
    expect(database.prepare('SELECT prompt FROM run_inputs WHERE run_id = ?').get('run-2'))
      .toEqual({ prompt: 'Materialized Hello' })
  })

  it('atomically replaces a first user input on a sibling root branch', () => {
    const database = createDatabase()
    const repository = createTurnRequestRepository(database)
    repository.prepare(createInput())
    database.prepare(`
      UPDATE runs SET status = 'completed', completed_at = ? WHERE id = 'run-1'
    `).run('2026-08-14T00:00:01.000Z')
    createComposerDraftRepository(database).open({
      ...createDraftInput(),
      draftId: 'draft-edit-1',
      now: '2026-08-14T00:00:01.500Z',
      scope: {
        branchId: 'branch-1',
        conversationId: 'conversation-1',
        kind: 'message_edit',
        userMessageId: 'message-1',
      },
    })

    const edited = repository.edit({
      ...createInput(),
      branchId: 'branch-2',
      createdAt: '2026-08-14T00:00:02.000Z',
      draft: { draftId: 'draft-edit-1', expectedRevision: 0 },
      forkedFromMessageId: null,
      parentBranchId: 'branch-1',
      requestFingerprint: 'edit-fingerprint-1',
      requestId: 'edit-request-1',
      runId: 'run-2',
      sourceUserMessageId: 'message-1',
      userMessageContent: { text: 'Edited hello' },
      userMessageId: 'message-2',
    })

    expect(edited).toMatchObject({ branchId: 'branch-2', created: true, runId: 'run-2' })
    expect(createConversationRepository(database)
      .listBranchMessages('conversation-1', 'branch-2')
      .map(message => [message.id, message.content]))
      .toEqual([['message-2', { text: 'Edited hello' }]])
    expect(createConversationRepository(database).listBranches('conversation-1')).toEqual([
      expect.objectContaining({ id: 'branch-1', parentBranchId: null }),
      expect.objectContaining({ id: 'branch-2', parentBranchId: null }),
    ])
  })
})

function createDatabase(): DatabaseSync {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  createComposerDraftRepository(database).open(createDraftInput())
  return database
}

function createInput() {
  return {
    attachmentBindings: [],
    attachmentIds: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-14T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    draft: { draftId: 'draft-1', expectedRevision: 0 },
    model: 'claude-sonnet-4-5',
    modelParameters: { contextWindow: 200_000, maxTokens: 32_000 },
    spaceId: null,
    provider: 'anthropic',
    requestFingerprint: 'fingerprint-1',
    requestId: 'request-1',
    runInput: {
      attachmentIds: [],
      contextItems: [{ kind: 'file' as const, value: 'notes.md' }],
      prompt: 'Materialized Hello',
      reasoning: 'high' as const,
      serviceTier: null,
    },
    runId: 'run-1',
    title: 'Hello',
    userMessageContent: { text: 'Hello' },
    userMessageId: 'message-1',
  }
}

function createDraftInput() {
  return {
    draftId: 'draft-1',
    initialContent: createBuddyUserContent('Hello'),
    initialExecutionConfig: {
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
    },
    initialModelSelection: {
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
      reasoning: 'high' as const,
      serviceTier: null,
    },
    now: '2026-08-14T00:00:00.000Z',
    scope: { kind: 'global' as const },
  }
}
