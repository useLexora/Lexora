import type { DatabaseSync } from 'node:sqlite'
import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import { afterEach, describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { buddyExecutionDefinitionSchema } from '../../buddies/BuddyExecutionDefinition'
import { createBuddyRepository } from '../buddyRepository'
import {
  CommandRequestConflictError,
  createCommandRequestRepository,
} from '../commandRequestRepository'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { createTurnRequestRepository } from '../turnRequestRepository'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('commandRequestRepository', () => {
  it('atomically creates one compaction run without a synthetic user message', () => {
    const database = createDatabase()
    seedCompletedTurn(database)
    const repository = createCommandRequestRepository(database)
    const input = commandInput()

    expect(repository.prepare(input)).toMatchObject({
      created: true,
      draftReceipt: {
        committedRevision: 3,
        draftId: 'draft-1',
        sourceRevision: 2,
      },
      runId: 'compact-run-1',
    })
    expect(repository.prepare(input)).toMatchObject({
      created: false,
      draftReceipt: {
        committedRevision: 3,
        draftId: 'draft-1',
        sourceRevision: 2,
      },
      runId: 'compact-run-1',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT purpose, pi_session_file FROM runs WHERE id = ?')
      .get('compact-run-1')).toEqual({
      pi_session_file: '/tmp/pi-session.jsonl',
      purpose: 'conversation.compaction',
    })
    expect(createRunRepository(database).findById('compact-run-1')?.actorSnapshot).toBeNull()
    expect(database.prepare('SELECT command, arguments FROM command_requests').get()).toEqual({
      arguments: 'focus on decisions',
      command: 'compact',
    })
    expect(createComposerDraftRepository(database).findById('draft-1')).toMatchObject({
      content: createBuddyUserContent(),
      revision: 3,
    })
  })

  it.each(['disabled', 'deleted'] as const)('preserves the source actor snapshot when its definition is %s after a leader change', (state) => {
    const database = createDatabase()
    const buddies = createBuddyRepository(database)
    const created = buddies.create({ name: 'Historical actor' })
    const actor = buddies.update({
      buddyId: created.id,
      expectedRevision: created.revision,
      settings: buddySettingsSchema.parse({ ...created.settings, instructions: 'Original role instructions.' }),
    })
    const snapshot = buddyExecutionDefinitionSchema.parse({
      version: 1,
      id: actor.id,
      kind: 'actor',
      revision: actor.revision,
      settings: actor.settings,
      model: { providerId: 'provider-1', modelId: 'model-1', reasoning: null, serviceTier: null },
      modelSource: 'application',
    })
    seedTurn(database, 'completed', snapshot)
    const next = buddies.create({ name: 'Current actor' })
    createConversationRepository(database).addMember({ id: 'conversation-1', buddyId: next.id, updatedAt: '2026-08-15T00:00:02.000Z' })
    createConversationRepository(database).setBuddy({ id: 'conversation-1', buddyId: next.id, updatedAt: '2026-08-15T00:00:02.000Z' })
    const changed = buddies.update({
      buddyId: actor.id,
      expectedRevision: actor.revision,
      enabled: state !== 'disabled',
      settings: buddySettingsSchema.parse({ ...actor.settings, instructions: 'Changed after the source turn.' }),
    })
    if (state === 'deleted')
      buddies.delete({ buddyId: actor.id, expectedRevision: changed.revision })

    createCommandRequestRepository(database).prepare(commandInput())

    expect(createRunRepository(database).findById('compact-run-1')).toMatchObject({
      buddyId: actor.id,
      actorSnapshot: snapshot,
      piSessionFile: '/tmp/pi-session.jsonl',
      purpose: 'conversation.compaction',
      status: 'queued',
    })
    expect(createRunRepository(database).findById('turn-run-1')?.actorSnapshot).toEqual(snapshot)
  })

  it('rejects conflicting, unbound and concurrently active command requests', () => {
    const empty = createDatabase()
    expect(() => createCommandRequestRepository(empty).prepare(commandInput()))
      .toThrow(CommandRequestConflictError)

    const active = createDatabase()
    seedTurn(active, 'running')
    expect(() => createCommandRequestRepository(active).prepare(commandInput()))
      .toThrow(CommandRequestConflictError)

    const deleting = createDatabase()
    seedCompletedTurn(deleting)
    deleting.prepare(`
      UPDATE conversations SET deleted_at = '2026-08-15T00:00:02.000Z'
      WHERE id = 'conversation-1'
    `).run()
    expect(() => createCommandRequestRepository(deleting).prepare(commandInput()))
      .toThrow(CommandRequestConflictError)

    const completed = createDatabase()
    seedCompletedTurn(completed)
    const repository = createCommandRequestRepository(completed)
    repository.prepare(commandInput())
    expect(() => repository.prepare({
      ...commandInput(),
      requestFingerprint: 'different',
    })).toThrow(CommandRequestConflictError)
  })

  it('replays an interrupted command receipt without starting another run', () => {
    const database = createDatabase()
    seedCompletedTurn(database)
    const repository = createCommandRequestRepository(database)
    repository.prepare(commandInput())
    database.prepare(`
      UPDATE runs
      SET status = 'failed', error_code = 'RUNTIME_RESTARTED', completed_at = ?
      WHERE id = 'compact-run-1'
    `).run('2026-08-15T00:00:02.000Z')

    expect(repository.prepare({
      ...commandInput(),
      runId: 'compact-run-2',
    })).toMatchObject({ created: false, runId: 'compact-run-1' })
    expect(database.prepare('SELECT run_id FROM command_requests').get())
      .toEqual({ run_id: 'compact-run-1' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 })
  })
})

function createDatabase(): DatabaseSync {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  return database
}

function seedCompletedTurn(database: DatabaseSync): void {
  seedTurn(database, 'completed')
}

function seedTurn(database: DatabaseSync, status: 'completed' | 'running', actorSnapshot?: BuddyExecutionDefinition): void {
  const drafts = createComposerDraftRepository(database)
  drafts.open({
    draftId: 'draft-1',
    initialContent: createBuddyUserContent('Hello'),
    initialExecutionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    initialModelSelection: {
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: null,
      serviceTier: null,
    },
    now: '2026-08-15T00:00:00.000Z',
    scope: { kind: 'global' },
  })
  createTurnRequestRepository(database).prepare({
    actorSnapshot,
    buddyId: actorSnapshot?.id,
    attachmentBindings: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-15T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    draft: { draftId: 'draft-1', expectedRevision: 0 },
    model: 'model-1',
    spaceId: null,
    provider: 'provider-1',
    requestFingerprint: 'turn-fingerprint-1',
    requestId: 'turn-request-1',
    runInput: {
      attachmentIds: [],
      contextItems: [],
      prompt: 'Hello',
      reasoning: null,
      serviceTier: null,
    },
    runId: 'turn-run-1',
    title: 'Hello',
    userMessageContent: { text: 'Hello' },
    userMessageId: 'message-1',
  })
  database.prepare(`
    UPDATE runs
    SET status = ?, pi_session_file = ?, completed_at = ?
    WHERE id = 'turn-run-1'
  `).run(
    status,
    '/tmp/pi-session.jsonl',
    status === 'completed' ? '2026-08-15T00:00:01.000Z' : null,
  )
  drafts.save({
    content: {
      body: [{
        content: [{
          commandMode: 'action',
          directive: 'slash_command',
          type: 'prompt_directive',
          value: '/compact',
        }, { text: ' focus on decisions', type: 'text' }],
        type: 'paragraph',
      }],
      panelResourceIds: [],
      version: 1,
    },
    draftId: 'draft-1',
    executionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    expectedRevision: 1,
    modelSelection: {
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: null,
      serviceTier: null,
    },
    now: '2026-08-15T00:00:01.500Z',
  })
}

function commandInput() {
  return {
    arguments: 'focus on decisions',
    branchId: 'branch-1',
    command: 'compact' as const,
    conversationId: 'conversation-1',
    createdAt: '2026-08-15T00:00:01.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    draft: { draftId: 'draft-1', expectedRevision: 2 },
    requestFingerprint: 'compact-fingerprint-1',
    requestId: 'compact-request-1',
    runId: 'compact-run-1',
  }
}
