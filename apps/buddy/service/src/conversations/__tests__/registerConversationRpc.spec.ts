import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { RegisterConversationRpcOptions } from '../registerConversationRpc'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationResponseSchemas } from '../../../../shared/conversation/conversationApi'
import { RunEventCorruptionError } from '../../events/RunEventFailure'
import { RunEventProjector } from '../../events/RunEventProjector'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { ConversationMetadataService } from '../ConversationMetadataService'
import { registerConversationRpc } from '../registerConversationRpc'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('registerConversationRpc', () => {
  it('persists explicit model selection without resolved token limits and rejects invalid reads', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-08-27T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: 'Original title',
    })
    const harness = createRpcHarness()
    registerConversationRpc({
      ...emptyConversationDependencies(conversations),
      rpc: harness.rpc,
      metadata: new ConversationMetadataService({
        repository: conversations,
        resolveModelSelection: async selection => ({ ...selection, contextWindow: 128_000, maxTokens: 16_384 }),
        sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) },
      }),
    })

    const modelSelection = {
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: 'high' as const,
      serviceTier: 'priority' as const,
    }
    await expect(harness.invoke('conversations.setModelSelection', {
      conversationId: 'conversation-1',
      modelSelection,
    })).resolves.toMatchObject({ modelSelection })
    const storedSelection = database.prepare(`
      SELECT model_selection_json, model_selection_source FROM conversation_members WHERE conversation_id = ? AND actor_id = 'default'
    `).get('conversation-1') as { model_selection_json: string, model_selection_source: string }
    expect(JSON.parse(storedSelection.model_selection_json)).toEqual(modelSelection)
    expect(storedSelection.model_selection_source).toBe('explicit')

    conversations.markDeleted('conversation-1', '2026-08-27T00:05:00.000Z')
    await expect(harness.invoke('conversations.get', {
      conversationId: 'conversation-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(harness.invoke('conversations.list', { unexpected: true }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('projects attachments, public actor replies, root events and artifacts while paging through the root input', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-08-27T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: 'Timeline',
    })
    conversations.createMessage({
      branchId: 'branch-1',
      content: { attachmentIds: ['attachment-1'], text: 'Inspect this' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:01:00.000Z',
      id: 'message-user',
      role: 'user',
      runId: null,
    })
    const run = {
      branchId: 'branch-1',
      completedAt: '2026-08-27T00:03:00.000Z',
      contextWindow: 128_000,
      conversationId: 'conversation-1',
      errorCode: null,
      executionContext: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      id: 'run-1',
      maxTokens: 16_384,
      model: 'model-1',
      piSessionFile: '/private/session.jsonl',
      provider: 'provider-1',
      purpose: 'chat' as const,
      startedAt: '2026-08-27T00:01:00.000Z',
      status: 'completed' as const,
      triggeringMessageId: 'message-user',
    }
    const runs = createRunRepository(database)
    runs.create(run)
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'Done' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:02:00.000Z',
      id: 'message-assistant',
      role: 'assistant',
      runId: 'run-1',
    })
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'Stored tool result' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:01:30.000Z',
      id: 'message-tool',
      role: 'tool',
      runId: 'run-1',
    })
    const actor = createBuddyRepository(database).create({ kind: 'actor', name: 'Supporting actor' })
    const child = runs.create({ ...run, id: 'actor-child', buddyId: actor.id, rootRunId: run.id, parentRunId: run.id, executionKind: 'actor_child', triggeringMessageId: 'private-child-task', piSessionFile: null })
    new RunEventProjector(database).project([{ runId: child.id, sequence: 1, type: 'message.completed', createdAt: '2026-08-27T00:02:40.000Z', payload: { messageId: 'public-child-answer', role: 'assistant', stopReason: 'completed', content: { text: 'Public supporting actor answer' } } }])
    const toolEvent = {
      createdAt: '2026-08-27T00:01:30.000Z',
      payload: { isError: false, toolCallId: 'tool-1', toolName: 'read' },
      runId: 'run-1',
      sequence: 1,
      type: 'tool.completed',
    }
    const outputEvent = {
      createdAt: '2026-08-27T00:02:30.000Z',
      payload: {
        artifactIds: ['artifact-1'],
        sourceToolCallId: 'tool-1',
        sourceToolName: 'lexora_image_generate',
      },
      runId: 'run-1',
      sequence: 2,
      type: 'output.produced',
    }
    const harness = createRpcHarness()
    registerConversationRpc({
      ...emptyConversationDependencies(conversations),
      artifacts: {
        listForConversation: () => [{
          conversationId: 'conversation-1',
          createdAt: '2026-08-27T00:02:20.000Z',
          currentPath: '/private/diagram.png',
          directoryGrantId: 'workspace-1',
          directoryRoot: '/private',
          id: 'artifact-1',
          kind: 'file',
          mimeType: 'image/png',
          name: 'diagram.png',
          relativePath: 'diagram.png',
          sizeBytes: 42,
          sourceArtifactId: null,
          updatedAt: '2026-08-27T00:02:20.000Z',
        }],
      },
      attachments: {
        listForConversation: () => [{
          conversationId: 'conversation-1',
          createdAt: '2026-08-27T00:00:30.000Z',
          draftId: null,
          id: 'attachment-1',
          messageId: 'message-user',
          mimeType: 'application/json',
          name: 'input.json',
          sizeBytes: 24,
          storedPath: '/private/input.json',
        }],
      },
      eventLog: { verifyRun: async () => {}, listForRuns: runIds => runIds.includes(run.id) ? [toolEvent, outputEvent] : [] },
      rpc: harness.rpc,
      runInputs: {
        findByRunId: () => ({
          attachmentIds: ['attachment-1'],
          contextItems: [],
          createdAt: '2026-08-27T00:01:00.000Z',
          prompt: 'Inspect this',
          reasoning: 'high',
          runId: 'run-1',
          serviceTier: null,
        }),
      },
      runs,
    })

    const timeline = await harness.invoke('conversations.listTimeline', {
      conversationId: 'conversation-1',
      limit: 2,
    }) as Record<string, unknown>
    expect(conversationResponseSchemas.timelinePage.safeParse(timeline).success).toBe(true)
    expect(timeline).toMatchObject({
      items: [
        {
          attachments: [{
            attachmentId: 'attachment-1',
            kind: 'text',
            mimeType: 'application/json',
            name: 'input.json',
            previewUrl: null,
            sizeBytes: 24,
          }],
          id: 'message-user',
        },
        { attachments: [], id: 'message-tool' },
        { attachments: [], id: 'message-assistant' },
        { attachments: [], id: 'public-child-answer', runId: child.id, content: { text: 'Public supporting actor answer' } },
      ],
      outputs: [{
        artifacts: [{
          artifactId: 'artifact-1',
          kind: 'file',
          name: 'diagram.png',
          path: '/private/diagram.png',
          previewUrl: null,
        }],
        runId: 'run-1',
        sourceToolCallId: 'tool-1',
      }],
      nextCursor: null,
      runEvents: [toolEvent, outputEvent],
      runs: [{
        id: 'run-1',
        modelId: 'model-1',
        providerId: 'provider-1',
        reasoningLevel: 'high',
      }],
    })
    expect(timeline).not.toHaveProperty('runs.0.piSessionFile')
    database.prepare('UPDATE runs SET root_run_id = id WHERE id = ?').run(child.id)
    await expect(harness.invoke('conversations.listTimeline', { conversationId: 'conversation-1', limit: 2 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

it('checks newly exposed history when repairing a stale projection changes the current page', async () => {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const now = '2026-11-02T00:00:00.000Z'
  conversations.create({ id: 'history', branchId: 'branch', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: 'History' })
  for (const [id, createdAt] of [['bad', '2026-11-02T00:01:00.000Z'], ['stale', '2026-11-02T00:02:00.000Z']] as const) {
    runs.create({ id, conversationId: 'history', branchId: 'branch', triggeringMessageId: 'input', provider: 'fixture', model: 'model', purpose: 'chat', status: 'completed', startedAt: createdAt, completedAt: createdAt, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
    conversations.createMessage({ id: `${id}-message`, conversationId: 'history', branchId: 'branch', role: 'assistant', runId: id, createdAt, content: { text: id } })
  }
  const harness = createRpcHarness()
  registerConversationRpc({
    ...emptyConversationDependencies(conversations),
    rpc: harness.rpc,
    eventLog: {
      listForRuns: () => [],
      async verifyRun(runId) {
        if (runId === 'stale')
          database.prepare('DELETE FROM messages WHERE id = ?').run('stale-message')
        else
          throw new RunEventCorruptionError(runId)
      },
    },
  })
  await expect(harness.invoke('conversations.listMessages', { conversationId: 'history', limit: 1 }))
    .rejects
    .toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
  expect(conversations.findMessageById('stale-message')).toBeNull()
  expect(conversations.findMessageById('bad-message')?.content).toEqual({ text: 'bad' })
})

function emptyConversationDependencies(
  conversations: ReturnType<typeof createConversationRepository>,
): Omit<RegisterConversationRpcOptions, 'rpc'> {
  return {
    artifacts: {
      listForConversation: () => [],
    },
    attachments: { listForConversation: () => [] },
    changes: { listSummariesForRuns: () => [] },
    conversations,
    deleteConversation: () => Promise.resolve(false),
    eventLog: { verifyRun: async () => {}, listForRuns: () => [] },
    isDeleting: () => false,
    metadata: new ConversationMetadataService({ repository: conversations, resolveModelSelection: selection => Promise.resolve(selection), sessions: { invalidateConversation: () => Promise.resolve({ pending: 0, degraded: 0 }) } }),
    runInputs: { findByRunId: () => null },
    runs: { listForTimeline: () => [] },
  }
}

function createRpcHarness() {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const rpc: RuntimeRequestRegistrar = {
    onRequest(method, handler) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
  }
  return {
    async invoke(method: string, params: unknown) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Missing handler: ${method}`)
      return await handler(params)
    },
    rpc,
  }
}
