import { describe, expect, it } from 'vitest'

import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { prepareTestCommandRequest, prepareTestTurnRequest } from './composerDraftTestFixture'

describe('buddy permission settings persistence', () => {
  it('atomically binds a conversation and every run to both permission axes', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)

    prepareTestTurnRequest(database, {
      approvalPolicy: 'manual',
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-23T00:00:00.000Z',
      executionProfile: 'full_access',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-1',
      requestId: 'request-1',
      runId: 'run-1',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'inspect the host',
        reasoning: null,
        serviceTier: null,
      },
      title: 'Inspect host',
      userMessageContent: { text: 'inspect the host' },
      userMessageId: 'message-1',
    })

    expect(conversations.findById('conversation-1')).toMatchObject({
      approvalPolicy: 'manual',
      executionProfile: 'full_access',
    })
    expect(runs.findById('run-1')).toMatchObject({
      approvalPolicy: 'manual',
      executionProfile: 'full_access',
    })
    expect(conversations.setPermissionSettings({
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      updatedAt: '2026-08-23T00:00:01.000Z',
    })).toMatchObject({ approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    expect(runs.findById('run-1')).toMatchObject({ approvalPolicy: 'manual', executionProfile: 'full_access' })

    runs.reconcileTerminal('run-1', 'completed', '2026-08-23T00:00:02.000Z', null)

    prepareTestTurnRequest(database, {
      approvalPolicy: 'policy',
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-23T00:00:04.000Z',
      executionProfile: 'workspace_write',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-2',
      requestId: 'request-2',
      runId: 'run-2',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'continue',
        reasoning: null,
        serviceTier: null,
      },
      title: null,
      userMessageContent: { text: 'continue' },
      userMessageId: 'message-2',
    })
    expect(runs.findById('run-2')).toMatchObject({
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    })

    runs.bindSession('run-2', '/tmp/session.jsonl')
    runs.reconcileTerminal('run-2', 'completed', '2026-08-23T00:00:05.000Z', null)
    prepareTestCommandRequest(database, {
      approvalPolicy: 'policy',
      arguments: '',
      branchId: 'branch-1',
      command: 'compact',
      conversationId: 'conversation-1',
      createdAt: '2026-08-23T00:00:06.000Z',
      executionProfile: 'workspace_write',
      requestFingerprint: 'command-fingerprint-1',
      requestId: 'command-request-1',
      runId: 'run-3',
    })
    expect(runs.findById('run-3')).toMatchObject({
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    })
    database.close()
  })
})
