import type { RunRecord } from '../../storage/runRecord'
import type { UsageRecord } from '../../storage/usageRepository'
import { describe, expect, it } from 'vitest'
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
    usage: { listForRun: (runId: string) => records.filter(record => record.runId === runId) } as never,
  })
}

describe('conversation status fold', () => {
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
      usage('run-1', 'provider-a', 'model-a', 'chat', { cacheReadTokens: 1_000, inputTokens: 200, outputTokens: 800, totalCost: 0.4 }),
      usage('run-3', 'provider-b', 'model-b', 'chat', { cacheReadTokens: 0, inputTokens: 300, outputTokens: 100, totalCost: 0.1 }),
      usage('run-4', 'provider-a', 'model-a', 'conversation.compaction', { cacheReadTokens: 0, inputTokens: 100, outputTokens: 50, totalCost: 0.05 }),
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
    expect(status.timing.slowestTools).toEqual([{ ms: 7_000, name: 'shell' }, { ms: 2_000, name: 'read' }])
    expect(status.timing.modelMs).toBe(10_000)
    expect(status.timing.ttft).toEqual({ averageMs: 2_000, maxMs: 2_000, samples: 1 })
    expect(status.timing.throughput.samples).toBe(1)
    // 输出速度只统计对话用途：输出 tokens 900 ÷ 生成耗时 8s
    expect(Math.round(status.timing.throughput.tokensPerSecond)).toBe(113)
    expect(status.timing.wallMs).toBe(360_000)

    expect(status.tokens.totals.totalTokens).toBe(2_550)
    expect(status.tokens.byModel.map(entry => [entry.modelId, entry.totalTokens, entry.runCount])).toEqual([
      ['model-a', 2_150, 2],
      ['model-b', 400, 1],
    ])
    expect(status.tokens.byPurpose.map(entry => [entry.purpose, entry.totalTokens])).toEqual([
      ['chat', 2_400],
      ['conversation.compaction', 150],
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
