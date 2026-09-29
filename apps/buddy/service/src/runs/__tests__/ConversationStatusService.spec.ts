import type { RunRecord } from '../../storage/runRecord'
import type { UsageRecord } from '../../storage/usageRepository'
import { describe, expect, it } from 'vitest'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionInvocationRepository } from '../../storage/extensionInvocationRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createUsageRepository } from '../../storage/usageRepository'
import { ConversationStatusService } from '../ConversationStatusService'

const conversationId = 'conversation-1'

function run(id: string, purpose: string, status: RunRecord['status'], triggeringMessageId: string): RunRecord {
  return {
    approvalPolicy: 'policy',
    branchId: 'branch-1',
    completedAt: null,
    contextWindow: null,
    conversationId,
    errorCode: null,
    executionProfile: 'workspace_write',
    id,
    maxTokens: null,
    model: 'model-a',
    piSessionFile: null,
    provider: 'provider-a',
    purpose,
    startedAt: '2026-09-20T10:00:00.000Z',
    status,
    triggeringMessageId,
  } as unknown as RunRecord
}

function usage(id: string, provider: string, model: string, purpose: string, counts: {
  cacheReadTokens: number
  inputTokens: number
  outputTokens: number
  totalCost: number
}): UsageRecord {
  const totalTokens = counts.cacheReadTokens + counts.inputTokens + counts.outputTokens
  return {
    cacheReadCost: 0,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteCost: 0,
    cacheWriteTokens: 0,
    createdAt: '2026-09-20T10:00:10.000Z',
    id,
    inputCost: 0,
    inputTokens: counts.inputTokens,
    model,
    outputCost: 0,
    outputTokens: counts.outputTokens,
    provider,
    purpose,
    reasoningTokens: null,
    runId: id,
    totalCost: counts.totalCost,
    totalTokens,
  } as unknown as UsageRecord
}

function event(sequence: number, type: string, payload: Record<string, unknown>, at: string) {
  return { createdAt: at, payload, runId: 'run-1', sequence, type }
}

function service(runs: readonly RunRecord[], events: readonly unknown[], records: readonly UsageRecord[]) {
  return new ConversationStatusService({
    events: { listForConversation: async () => events } as never,
    repository: { listForConversation: () => runs } as never,
    usage: { listForConversation: () => records } as never,
  })
}

describe('conversation status fold', () => {
  it('includes the task independent ledger, including cancelled consumption, without inventing runs or mixing other tasks', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const conversations = createConversationRepository(database)
      const runs = createRunRepository(database)
      const invocations = createExtensionInvocationRepository(database)
      const records = createUsageRepository(database)
      for (const id of [conversationId, 'other-task', 'action-only'])
        conversations.create({ id, branchId: `${id}-branch`, title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-20T10:00:00.000Z' })
      for (const id of [conversationId, 'other-task']) {
        const runId = id === conversationId ? 'run-1' : 'other-run'
        runs.create({ ...run(runId, 'chat', 'completed', 'message-1'), conversationId: id, branchId: `${id}-branch` })
        database.prepare(`INSERT INTO usage_records (
          id, run_id, source_entry_id, provider, model, purpose,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
          input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
        ) VALUES (?, ?, 'turn', 'provider-a', 'model-a', 'turn', 10, 20, 0, 0, NULL, 30, 0, 0, 0, 0, 0.1, '2026-09-20T10:00:10.000Z')`).run(runId, runId)
      }
      const events = [
        event(1, 'message.started', { messageId: 'assistant', role: 'assistant' }, '2026-09-20T10:00:00.000Z'),
        event(2, 'message.block.started', { messageId: 'assistant', kind: 'text' }, '2026-09-20T10:00:01.000Z'),
        event(3, 'message.completed', { messageId: 'assistant', role: 'assistant' }, '2026-09-20T10:00:11.000Z'),
      ]
      const statusService = new ConversationStatusService({ repository: runs, usage: records, events: { listForConversation: async (id: string) => id === conversationId ? events : [] } as never })
      const before = await statusService.status(conversationId)
      for (const id of [conversationId, 'other-task', 'action-only']) {
        invocations.start({ id, conversationId: id, extensionId: 'tests.action', actionId: 'tests.action.generate', trigger: 'user', startedAt: '2026-09-20T10:00:20.000Z' })
        records.recordInvocation({ ...usage(id, 'provider-b', 'model-b', 'extension.action', { cacheReadTokens: 300, inputTokens: 100, outputTokens: 200, totalCost: 0.4 }), runId: null, invocationId: id, sourceEntryId: 'generation', reasoningTokens: 50 })
        invocations.finish(id, 'cancelled')
      }
      const status = await statusService.status(conversationId)
      expect(records.listForConversation(conversationId).map(record => record.id)).toEqual([conversationId, 'run-1'])
      expect(status.tokens.totals).toEqual({ inputTokens: 110, outputTokens: 220, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 50, totalTokens: 630, totalCost: 0.5, recordCount: 2 })
      expect(status.tokens.byModel).toMatchObject([{ modelId: 'model-b', runCount: 0, totalTokens: 600 }, { modelId: 'model-a', runCount: 1, totalTokens: 30 }])
      expect(status.tokens.byPurpose).toMatchObject([{ purpose: 'extension.action', totalTokens: 600 }, { purpose: 'turn', totalTokens: 30 }])
      expect(status.activity).toEqual(before.activity)
      expect(status.timing).toEqual(before.timing)
      expect(status.timing.throughput.tokensPerSecond).toBe(2)

      const actionOnly = await statusService.status('action-only')
      expect(actionOnly.tokens.totals).toMatchObject({ totalTokens: 600, totalCost: 0.4, recordCount: 1 })
      expect(actionOnly.activity.runs.chat.total).toBe(0)
      expect(actionOnly.timing.throughput).toEqual({ samples: 0, tokensPerSecond: 0 })
      expect((await statusService.status('unknown-task')).tokens.totals.totalTokens).toBe(0)
    }
    finally { database.close() }
  })

  it('keeps lifetime usage outside the run sampling window out of sampled throughput', async () => {
    const events = [
      event(1, 'message.started', { messageId: 'assistant' }, '2026-09-20T10:00:00.000Z'),
      event(2, 'message.block.started', { messageId: 'assistant', kind: 'text' }, '2026-09-20T10:00:01.000Z'),
      event(3, 'message.completed', { messageId: 'assistant' }, '2026-09-20T10:00:11.000Z'),
    ]
    const status = await service([run('run-1', 'chat', 'completed', 'message-1')], events, [
      usage('run-1', 'provider', 'model', 'turn', { cacheReadTokens: 0, inputTokens: 10, outputTokens: 20, totalCost: 0.1 }),
      usage('old-run', 'provider', 'model', 'turn', { cacheReadTokens: 0, inputTokens: 10, outputTokens: 2000, totalCost: 10 }),
    ]).status(conversationId)
    expect(status.tokens.totals).toMatchObject({ totalTokens: 2040, totalCost: 10.1 })
    expect(status.timing.throughput.tokensPerSecond).toBe(2)
  })

  it('folds activity, timing, and per-model tokens from runs, events, and usage records', async () => {
    const runs = [
      run('run-1', 'chat', 'completed', 'message-1'),
      run('run-2', 'chat', 'failed', 'message-2'),
      run('run-3', 'chat', 'completed', 'message-2'),
      run('run-4', 'conversation.compaction', 'completed', 'message-2'),
    ]
    const events = [
      event(1, 'run.started', {}, '2026-09-20T10:00:00.000Z'),
      event(2, 'message.started', { messageId: 'assistant-1', role: 'assistant' }, '2026-09-20T10:00:01.000Z'),
      event(3, 'message.block.started', { contentIndex: 0, kind: 'text', messageId: 'assistant-1' }, '2026-09-20T10:00:03.000Z'),
      event(4, 'message.completed', { messageId: 'assistant-1', role: 'assistant' }, '2026-09-20T10:00:11.000Z'),
      event(5, 'tool.started', { toolCallId: 'call-1', toolName: 'read' }, '2026-09-20T10:00:12.000Z'),
      event(6, 'tool.completed', { isError: false, toolCallId: 'call-1', toolName: 'read' }, '2026-09-20T10:00:14.000Z'),
      event(7, 'tool.started', { toolCallId: 'call-2', toolName: 'shell' }, '2026-09-20T10:00:15.000Z'),
      event(8, 'tool.completed', { isError: true, toolCallId: 'call-2', toolName: 'shell' }, '2026-09-20T10:00:22.000Z'),
      event(9, 'tool.started', { toolCallId: 'call-3', toolName: 'read' }, '2026-09-20T10:00:23.000Z'),
      event(10, 'tool.denied', { toolCallId: 'call-3', toolName: 'read' }, '2026-09-20T10:00:24.000Z'),
      event(11, 'context.compaction.completed', { estimatedTokensAfter: 21_000, reason: 'manual', tokensBefore: 84_000, willRetry: false }, '2026-09-20T10:05:00.000Z'),
      event(12, 'run.completed', { errorCode: null }, '2026-09-20T10:06:00.000Z'),
    ]
    const records = [
      usage('run-1', 'provider-a', 'model-a', 'turn', { cacheReadTokens: 1_000, inputTokens: 200, outputTokens: 800, totalCost: 0.4 }),
      usage('run-3', 'provider-b', 'model-b', 'turn', { cacheReadTokens: 0, inputTokens: 300, outputTokens: 100, totalCost: 0.1 }),
      usage('run-4', 'provider-a', 'model-a', 'compaction', { cacheReadTokens: 0, inputTokens: 100, outputTokens: 50, totalCost: 0.05 }),
    ]

    const status = await service(runs, events, records).status(conversationId)

    expect(status.activity.turns).toBe(2)
    expect(status.activity.runs.chat).toEqual({ cancelled: 0, failed: 1, running: 0, succeeded: 2, total: 3 })
    expect(status.activity.runs.compaction).toEqual({ cancelled: 0, failed: 0, running: 0, succeeded: 1, total: 1 })
    expect(status.activity.tools).toEqual({
      denied: 1,
      failed: 1,
      running: 0,
      succeeded: 1,
      top: [{ count: 2, name: 'read' }, { count: 1, name: 'shell' }],
      total: 3,
    })
    expect(status.activity.compactions).toEqual({ count: 1, lastAfterTokens: 21_000, lastBeforeTokens: 84_000 })

    expect(status.timing.toolMs).toBe(9_000)
    expect(status.timing.modelMs).toBe(10_000)
    expect(status.timing.ttft).toEqual({ averageMs: 2_000, maxMs: 2_000, samples: 1 })
    expect(status.timing.throughput.samples).toBe(1)
    // 输出速度只统计对话用途：输出 tokens 900 ÷ 生成耗时 8s
    expect(Math.round(status.timing.throughput.tokensPerSecond)).toBe(113)
    expect(status.timing.wallMs).toBe(360_000)

    const withWarming = await service(runs, events, [...records, usage('run-1', 'provider-a', 'model-a', 'cache_warm', { cacheReadTokens: 100_000, inputTokens: 0, outputTokens: 1, totalCost: 0.1 })]).status(conversationId)
    expect(withWarming.timing).toEqual(status.timing)
    expect(withWarming.tokens.totals.totalCost).toBeCloseTo(status.tokens.totals.totalCost + 0.1)
    expect(withWarming.tokens.byPurpose.find(entry => entry.purpose === 'cache_warm')?.totalTokens).toBe(100_001)

    expect(status.tokens.totals.totalTokens).toBe(2_550)
    expect(status.tokens.byModel.map(entry => [entry.modelId, entry.totalTokens, entry.runCount])).toEqual([
      ['model-a', 2_150, 2],
      ['model-b', 400, 1],
    ])
    expect(status.tokens.byPurpose.map(entry => [entry.purpose, entry.totalTokens])).toEqual([
      ['turn', 2_400],
      ['compaction', 150],
    ])
  })

  it('reports empty figures for a conversation without runs', async () => {
    const status = await service([], [], []).status(conversationId)

    expect(status.activity.turns).toBe(0)
    expect(status.activity.tools.total).toBe(0)
    expect(status.timing).toMatchObject({ modelMs: 0, toolMs: 0, wallMs: 0 })
    expect(status.tokens.totals.totalTokens).toBe(0)
  })
})
