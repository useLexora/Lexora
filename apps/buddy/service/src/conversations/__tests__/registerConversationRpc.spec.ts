import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { RegisterConversationRpcOptions } from '../registerConversationRpc'
import { afterEach, describe, expect, it } from 'vitest'
import { RunEventCorruptionError } from '../../events/RunEventFailure'
import { RunEventProjector } from '../../events/RunEventProjector'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createConversationArchiveRepository } from '../../storage/conversationArchiveRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { ConversationMetadataService } from '../ConversationMetadataService'
import { registerConversationRpc } from '../registerConversationRpc'
import { registerConversationTreeRpc } from '../registerConversationTreeRpc'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('registerConversationRpc', () => {
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

it('reads archived details, models, members and usage without permitting writes or exposing deleted history', async () => {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  const now = '2026-11-07T00:00:00.000Z'
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  conversations.create({ id: 'archived', branchId: 'archived-branch', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: 'Archived detail' })
  conversations.createMessage({ id: 'input', conversationId: 'archived', branchId: 'archived-branch', role: 'user', runId: null, createdAt: now, content: { text: 'Original question' } })
  runs.create({ id: 'historical-run', conversationId: 'archived', branchId: 'archived-branch', triggeringMessageId: 'input', provider: 'fixture', model: 'model', purpose: 'chat', status: 'completed', startedAt: now, completedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
  conversations.createMessage({ id: 'answer', conversationId: 'archived', branchId: 'archived-branch', role: 'assistant', runId: 'historical-run', createdAt: now, content: { text: 'Archived answer' } })
  database.prepare(`INSERT INTO usage_records (id, run_id, source_entry_id, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at)
    VALUES ('usage', 'historical-run', 'answer', 'fixture', 'model', 'chat', 10, 20, 0, 0, 30, 0, 0, 0, 0, 0, ?)`).run(now)
  createConversationArchiveRepository(database).archive('archived', now)
  const harness = createRpcHarness()
  const dependencies = emptyConversationDependencies(conversations)
  registerConversationRpc({ ...dependencies, rpc: harness.rpc })
  registerConversationTreeRpc({ ...dependencies, rpc: harness.rpc, database, conversations, runs })
  const scope = { conversationId: 'archived' }
  await expect(harness.invoke('conversations.list', {})).resolves.toEqual([])
  await expect(harness.invoke('conversations.list', { filter: { query: 'Archived' } })).resolves.toEqual([])
  await expect(harness.invoke('conversations.get', scope)).resolves.toMatchObject({ id: 'archived', archivedAt: now })
  await expect(harness.invoke('conversations.listBranches', scope)).resolves.toMatchObject([{ id: 'archived-branch' }])
  await expect(harness.invoke('conversations.listMessages', scope)).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'answer' })]) })
  await expect(harness.invoke('conversations.listTimeline', scope)).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'answer' })]) })
  await expect(harness.invoke('conversations.listMembers', scope)).resolves.toMatchObject([{ actorId: 'default' }])
  await expect(harness.invoke('conversations.getModelControls', scope)).resolves.toMatchObject({ next: { actorId: 'default', isMember: true } })
  await expect(harness.invoke('conversations.getTree', scope)).resolves.toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ runId: 'historical-run', metadata: expect.objectContaining({ usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }) })]) })
  await expect(harness.invoke('conversations.getNodeDetail', { ...scope, kind: 'answer', runId: 'historical-run' })).resolves.toMatchObject({ items: [{ id: 'answer' }] })
  await expect(harness.invoke('conversations.rename', { ...scope, title: 'Must not change' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await expect(harness.invoke('conversations.setModelSelection', { ...scope, modelSelection: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  expect(conversations.findById('archived')?.title).toBe('Archived detail')
  conversations.markDeleted('archived', now)
  for (const method of ['get', 'listBranches', 'listMessages', 'listTimeline', 'listMembers', 'getModelControls', 'getTree'])
    await expect(harness.invoke(`conversations.${method}`, scope)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await expect(harness.invoke('conversations.getNodeDetail', { ...scope, kind: 'answer', runId: 'historical-run' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
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
