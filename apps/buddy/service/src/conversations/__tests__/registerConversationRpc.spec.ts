import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { RegisterConversationRpcOptions } from '../registerConversationRpc'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('owns conversation mutations, lifecycle effects and the persisted model-selection shape', async () => {
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
    conversations.createBranch({
      activate: false,
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:01:00.000Z',
      forkedFromMessageId: null,
      id: 'branch-2',
      parentBranchId: null,
    })
    const effects: string[] = []
    const harness = createRpcHarness()
    registerConversationRpc({
      ...emptyConversationDependencies(conversations),
      async deleteConversation(conversationId) {
        effects.push(`delete:${conversationId}`)
        return conversations.markDeleted(conversationId, '2026-08-27T00:05:00.000Z')
      },
      rpc: harness.rpc,
      metadata: new ConversationMetadataService({
        repository: conversations,
        resolveModelSelection: async selection => ({ ...selection, contextWindow: 128_000, maxTokens: 16_384 }),
        sessions: {
          async invalidateConversation(conversationId) {
            effects.push(`session:${conversationId}`)
            return { pending: 0, degraded: 0 }
          },
        },
      }),
    })

    await expect(harness.invoke('conversations.list', {}))
      .resolves
      .toEqual([expect.objectContaining({ id: 'conversation-1' })])
    await expect(harness.invoke('conversations.rename', {
      conversationId: 'conversation-1',
      title: '  Renamed conversation  ',
    })).resolves.toMatchObject({ title: 'Renamed conversation' })
    await expect(harness.invoke('conversations.setPermissionSettings', {
      conversationId: 'conversation-1',
      approvalPolicy: 'manual',
      executionProfile: 'workspace_write',
    })).resolves.toMatchObject({
      approvalPolicy: 'manual',
      executionProfile: 'workspace_write',
    })
    await expect(harness.invoke('conversations.setPermissionSettings', {
      conversationId: 'conversation-1',
      approvalPolicy: 'manual',
      executionProfile: 'workspace_write',
    })).resolves.toMatchObject({ approvalPolicy: 'manual' })
    expect(effects).toEqual(['session:conversation-1'])

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
      SELECT model_selection_json FROM conversations WHERE id = ?
    `).get('conversation-1') as { model_selection_json: string }
    expect(JSON.parse(storedSelection.model_selection_json)).toEqual(modelSelection)

    await expect(harness.invoke('conversations.activateBranch', {
      branchId: 'branch-2',
      conversationId: 'conversation-1',
    })).resolves.toMatchObject({ activeBranchId: 'branch-2' })
    await expect(harness.invoke('conversations.listBranches', {
      conversationId: 'conversation-1',
    })).resolves.toHaveLength(2)
    await expect(harness.invoke('conversations.delete', {
      conversationId: 'conversation-1',
    })).resolves.toBe(true)
    expect(effects).toEqual(['session:conversation-1', 'delete:conversation-1'])
    await expect(harness.invoke('conversations.get', {
      conversationId: 'conversation-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(harness.invoke('conversations.list', { unexpected: true }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('projects attachments, runs, public events and artifacts as one timeline read model', async () => {
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
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'Done' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:02:00.000Z',
      id: 'message-assistant',
      role: 'assistant',
      runId: 'run-1',
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
      content: { text: 'Stored tool result' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-27T00:01:30.000Z',
      id: 'message-tool',
      role: 'tool',
      runId: 'run-1',
    })
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
      eventLog: { listForRuns: runIds => runIds.includes(run.id) ? [toolEvent, outputEvent] : [] },
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
    expect(conversations.listMessages('conversation-1', 'branch-1').map(message => message.id))
      .toEqual(['message-user', 'message-tool', 'message-assistant'])
  })
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
    eventLog: { listForRuns: () => [] },
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
