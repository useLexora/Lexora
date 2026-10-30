import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { RunRecord } from '../../storage/runRecord'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { conversationStatusSchema } from '../../../../shared/runs/conversationStatusApi'
import { taskMetricsChangedSchema, taskMetricsSchema } from '../../../../shared/runs/taskMetricsApi'
import { createExecutionStorageFixture, executionNow } from '../../storage/__tests__/executionFixture'
import { createConversationStatisticsRepository } from '../../storage/conversationStatisticsRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionInvocationRepository } from '../../storage/extensionInvocationRepository'
import { createRunRepository } from '../../storage/runRepository'
import { ConversationStatusService } from '../ConversationStatusService'
import { registerRunRpc } from '../registerRunRpc'

const scope = { conversationId: 'conversation', branchId: 'branch' }
const databases: DatabaseSync[] = []
const services: ConversationStatusService[] = []
afterEach(() => {
  for (const service of services.splice(0))
    service.dispose()
  vi.useRealTimers()
  for (const database of databases.splice(0))
    database.close()
})

function createMetricsService(database: DatabaseSync, commits = new Emitter<BuddyRunEvent>(() => {})) {
  const service = new ConversationStatusService({
    repository: createConversationStatisticsRepository(database),
    runs: createRunRepository(database),
    events: { onDidCommit: commits.event },
  })
  services.push(service)
  return service
}

function fixture(path?: string) {
  const storage = createExecutionStorageFixture(path)
  databases.push(storage.database)
  const { conversations, runs, database } = storage
  const root = runs.findById('root')!
  let sequence = 0
  const message = (id: string, runId: string, branchId = 'branch', createdAt = executionNow) => conversations.createMessage({
    id,
    runId,
    branchId,
    conversationId: 'conversation',
    role: 'user',
    content: { text: 'fixture' },
    createdAt,
  })
  message('goal', 'root')
  const commits = new Emitter<BuddyRunEvent>(() => {})
  const service = createMetricsService(database, commits)
  const run = (id: string, patch: Partial<RunRecord> = {}) => {
    runs.create({ ...root, id, rootRunId: id, triggeringMessageId: `input-${id}`, ...patch })
    if (!patch.executionKind || patch.executionKind === 'root')
      message(`input-${id}`, id, patch.branchId, patch.startedAt)
  }
  const event = (runId: string, type: string, payload: unknown, createdAt = executionNow) => {
    const next = ++sequence
    database.prepare('INSERT INTO run_events(run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, next, type, JSON.stringify(payload), createdAt)
    commits.fire({ runId, type, payload, sequence: next, createdAt })
    return next
  }
  const step = (runId: string, messageId: string) => event(runId, 'message.started', { role: 'assistant', messageId })
  const timing = (runId: string, messageId: string, decodeMs: number, stopReason = 'completed') => {
    event(runId, 'message.block.started', { messageId, kind: 'text' }, new Date(Date.parse(executionNow) + 1000).toISOString())
    event(runId, 'message.completed', { messageId, role: 'assistant', stopReason }, new Date(Date.parse(executionNow) + 1000 + decodeMs).toISOString())
  }
  const usage = (runId: string | null, source: string, outputTokens: number, purpose = 'turn', invocationId: string | null = null) => {
    database.prepare(`INSERT INTO usage_records (
      id, run_id, invocation_id, source_entry_id, provider, model, purpose,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
    ) VALUES (?, ?, ?, ?, 'fixture', 'fixture', ?, 10, ?, 20, 3, NULL, ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT(run_id, source_entry_id, purpose) DO NOTHING`)
      .run(`usage-${runId}-${source}-${purpose}`, runId, invocationId, source, purpose, outputTokens, outputTokens + 33, executionNow)
  }
  return { ...storage, service, commits, run, event, step, timing, usage, message }
}

describe('conversation statistics', () => {
  it('coalesces committed root and child changes by conversation and publishes no private payload', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.run('child', { executionKind: 'npc_child', rootRunId: 'root', parentRunId: 'root' })
    f.conversations.create({ id: 'other', branchId: 'other-branch', title: 'Other', createdAt: executionNow, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    f.runs.create({ ...f.runs.findById('root')!, id: 'other-run', rootRunId: 'other-run', conversationId: 'other', branchId: 'other-branch' })
    const notices: unknown[] = []
    f.service.onDidChange(event => notices.push(event))
    f.event('root', 'run.started', { text: 'private-input' })
    f.event('child', 'context.usage.updated', { private: 'child-context' })
    f.event('other-run', 'usage.recorded', { private: 'other-usage' })
    await vi.advanceTimersByTimeAsync(119)
    expect(notices).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(notices).toEqual([{ conversationId: 'conversation', revision: 1 }, { conversationId: 'other', revision: 2 }])
    for (const notice of notices)
      expect(taskMetricsChangedSchema.safeParse(notice).success).toBe(true)
    f.event('root', 'run.completed', {})
    await vi.advanceTimersByTimeAsync(120)
    expect(notices.at(-1)).toEqual({ conversationId: 'conversation', revision: 3 })
  })

  it('ignores ordinary deltas and tool progress without fabricating metric changes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const initial = f.service.metrics(scope)
    const snapshots: unknown[] = []
    f.service.onDidChange(() => snapshots.push(f.service.metrics(scope)))
    for (let index = 0; index < 300; index++) {
      f.event('root', 'message.delta', { messageId: 'answer', delta: 'private' })
      f.event('root', 'tool.updated', { toolCallId: 'tool', output: 'private' })
    }
    await vi.advanceTimersByTimeAsync(240)
    expect(snapshots).toEqual([])
    expect(f.service.metrics(scope)).toEqual(initial)
    f.step('root', 'answer')
    await vi.advanceTimersByTimeAsync(120)
    expect(snapshots).toEqual([{ ...initial, steps: 1 }])
  })

  it('notifies accepted inputs without requiring another model event and stops all notifications on disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const snapshots: unknown[] = []
    f.service.metrics(scope)
    f.service.onDidChange(() => snapshots.push(f.service.metrics(scope)))
    f.message('accepted-steer', 'root')
    f.service.notifyChanged(scope.conversationId)
    await vi.advanceTimersByTimeAsync(120)
    expect(snapshots).toEqual([expect.objectContaining({ turns: 2, steps: 0 })])
    f.event('root', 'usage.recorded', {})
    f.service.dispose()
    f.service.notifyChanged(scope.conversationId)
    f.event('root', 'run.cancelled', {})
    await vi.advanceTimersByTimeAsync(120)
    expect(snapshots).toHaveLength(1)
  })

  it('registers the strict read-only runs.metrics RPC', async () => {
    const { service, runs } = fixture()
    const handlers = new Map<string, RuntimeRequestHandler>()
    const dispose = registerRunRpc({
      statistics: service,
      isBusy: () => false,
      repository: runs,
      inputs: { findByRunId: () => null },
      eventLog: { list: async () => [], listForConversation: () => [] },
      rpc: {
        onRequest(method, handler) {
          handlers.set(method, handler)
          return () => {
            handlers.delete(method)
          }
        },
      },
    })
    const handler = handlers.get('runs.metrics')!
    expect(await handler(scope)).toEqual(service.metrics(scope))
    expect(() => handler({ ...scope, branchId: 'missing' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => handler({ ...scope, extra: true })).toThrow()
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('does not truncate totals at the previous 1000-run or 20000-event limits', async () => {
    const { service, database, run, step, usage, event, timing } = fixture()
    step('root', 'answer')
    usage('root', 'answer', 1)
    timing('root', 'answer', 1000)
    for (let index = 0; index < 1001; index++) {
      const id = `run-${index}`
      run(id)
      step(id, 'answer')
      usage(id, 'answer', 1)
      timing(id, 'answer', 1000)
    }
    database.exec('BEGIN')
    for (let index = 0; index < 20001; index++)
      event('root', 'tool.started', { toolCallId: `tool-${index}` })
    database.exec('COMMIT')
    expect(service.metrics(scope)).toMatchObject({ turns: 1002, steps: 1002, tokens: { outputTokens: 1002 }, throughput: { samples: 1002, tokensPerSecond: 1 } })
    const status = await service.status(scope.conversationId, scope.branchId)
    expect(status.timing.throughput).toEqual(service.metrics(scope).throughput)
    expect(status.activity).toMatchObject({ tools: { total: 20001 }, runs: { chat: { total: 1002 } } })
    expect((await service.status(scope.conversationId)).timing.throughput).toEqual(status.timing.throughput)
    step('root', 'live-next')
    usage('root', 'live-next', 2)
    expect(service.metrics(scope)).toMatchObject({ turns: 1002, steps: 1003, tokens: { outputTokens: 1004 } })
  })

  it('keeps an unknown unscoped task empty while scoped requests reject unknown or cross-task targets', async () => {
    const f = fixture()
    const status = await f.service.status('unknown')
    expect(conversationStatusSchema.parse(status)).toEqual(status)
    expect(status.tokens.totals).toMatchObject({ totalTokens: 0, recordCount: 0, totalCost: 0 })
    expect(status.activity).toMatchObject({ turns: 0, runs: { chat: { total: 0 } }, tools: { total: 0 } })
    expect(status.timing).toMatchObject({ modelMs: 0, wallMs: 0, toolMs: 0, throughput: { samples: 0, tokensPerSecond: null } })
    await expect(f.service.status('unknown', scope.branchId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(f.service.status(scope.conversationId, 'unknown')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(() => f.service.metrics({ conversationId: 'unknown', branchId: scope.branchId })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    f.conversations.create({ id: 'unknown', branchId: 'unknown-branch', title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: executionNow })
    createExtensionInvocationRepository(f.database).start({ id: 'new-action', conversationId: 'unknown', extensionId: 'fixture', actionId: 'fixture', trigger: 'user', startedAt: executionNow })
    f.usage(null, 'new-usage', 20, 'extension.action', 'new-action')
    expect((await f.service.status('unknown')).tokens.totals.outputTokens).toBe(20)
  })

  it('validates the target without activating another branch or accepting cross-conversation targets', () => {
    const { service, conversations } = fixture()
    conversations.create({ id: 'other', branchId: 'other-branch', title: 'Other', createdAt: executionNow, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    expect(() => service.metrics({ ...scope, branchId: 'other-branch' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => service.metrics({ ...scope, conversationId: 'missing' })).toThrow()
    expect(service.metrics(scope)).toMatchObject({ turns: 1, steps: 0, throughput: { samples: 0, tokensPerSecond: null } })
    expect(conversations.findById('conversation')?.activeBranchId).toBe('branch')
  })

  it('includes actor/NPC consumption once, excludes cache warming and keeps cache hits separate from input', async () => {
    const { service, database, run, step, usage, timing, event } = fixture()
    run('actor', { executionKind: 'actor_child', rootRunId: 'root', parentRunId: 'root' })
    run('npc', { executionKind: 'npc_child', rootRunId: 'root', parentRunId: 'actor' })
    expect(service.metrics(scope).steps).toBe(0)
    createExtensionInvocationRepository(database).start({
      id: 'action',
      extensionId: 'fixture',
      actionId: 'fixture',
      conversationId: 'conversation',
      branchId: 'branch',
      trigger: 'user',
      startedAt: executionNow,
    })
    usage(null, 'independent-action', 9000, 'extension.action', 'action')
    for (const id of ['root', 'actor', 'npc']) {
      step(id, 'answer')
      step(id, 'answer')
      usage(id, 'answer', 40)
      usage(id, 'answer', 40)
      usage(id, 'warm', 5000, 'cache_warm')
      timing(id, 'answer', 2000)
      timing(id, 'answer', 2000)
      event(id, 'tool.started', { toolCallId: 'tool' })
    }
    const metrics = service.metrics(scope)
    expect(taskMetricsSchema.parse(metrics)).toEqual({
      ...scope,
      turns: 1,
      steps: 3,
      tokens: { inputTokens: 30, outputTokens: 120, cacheReadTokens: 60, cacheWriteTokens: 9 },
      throughput: { samples: 3, tokensPerSecond: 20 },
    })
    expect(service.metrics(scope)).toEqual(metrics)
    expect(createMetricsService(database).metrics(scope)).toEqual(metrics)
    const scoped = await service.status(scope.conversationId, scope.branchId)
    expect(scoped.tokens.totals).toMatchObject(metrics.tokens)
    expect(scoped.timing.throughput).toEqual(metrics.throughput)
    expect(scoped.activity.tools.total).toBe(3)
    const full = await service.status(scope.conversationId)
    expect(conversationStatusSchema.parse(full)).toEqual(full)
    expect(full.tokens.totals).toMatchObject({ outputTokens: 24120, recordCount: 7 })
    expect(full.tokens.byPurpose).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: 'turn', outputTokens: 120, recordCount: 3 }),
      expect.objectContaining({ purpose: 'cache_warm', outputTokens: 15000, recordCount: 3 }),
      expect.objectContaining({ purpose: 'extension.action', outputTokens: 9000, recordCount: 1 }),
    ]))
    expect(full.timing.throughput).toEqual(metrics.throughput)
    expect(full.activity).toEqual(scoped.activity)
  })

  it('selects visible ancestor roots and their children, not abandoned siblings or later ancestor turns', async () => {
    const { conversations, service, run, step, usage, timing } = fixture()
    step('root', 'first')
    usage('root', 'first', 10)
    run('npc', { executionKind: 'npc_child', rootRunId: 'root', parentRunId: 'root' })
    step('npc', 'private')
    usage('npc', 'private', 20)
    timing('root', 'first', 1000)
    timing('npc', 'private', 1000)
    conversations.createBranch({ id: 'fork', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'goal', createdAt: '2026-10-12T00:01:00.000Z', activate: false })
    run('later', { startedAt: '2026-10-12T00:02:00.000Z' })
    step('later', 'abandoned')
    usage('later', 'abandoned', 1000)
    timing('later', 'abandoned', 1000)
    expect(service.metrics({ ...scope, branchId: 'fork' }).tokens.outputTokens).toBe(30)
    run('fork-root', { branchId: 'fork', startedAt: '2026-10-12T00:03:00.000Z' })
    step('fork-root', 'fork-answer')
    usage('fork-root', 'fork-answer', 30)
    timing('fork-root', 'fork-answer', 1000)
    run('bad-child', { executionKind: 'npc_child', rootRunId: 'root', parentRunId: 'root', branchId: 'fork' })
    usage('bad-child', 'cross-branch', 5000)
    expect(service.metrics({ ...scope, branchId: 'fork' })).toMatchObject({ turns: 2, steps: 3, tokens: { outputTokens: 60 } })
    expect(service.metrics(scope)).toMatchObject({ turns: 2, steps: 3, tokens: { outputTokens: 1030 } })
    for (const branchId of ['branch', 'fork']) {
      const metrics = service.metrics({ ...scope, branchId })
      const status = await service.status(scope.conversationId, branchId)
      expect(status.tokens.totals).toMatchObject(metrics.tokens)
      expect(status.timing.throughput).toEqual(metrics.throughput)
    }
    expect((await service.status(scope.conversationId)).tokens.totals.outputTokens).toBe(6060)
    expect(conversations.findById('conversation')?.activeBranchId).toBe('branch')
  })

  it.each([
    { cut: 'goal', expectedCompactions: 0, expectedOutput: 10 },
    { cut: 'same-time', expectedCompactions: 0, expectedOutput: 10 },
    { cut: 'later-input', expectedCompactions: 1, expectedOutput: 17 },
  ])('inherits ancestor compaction at its timeline position through $cut, not its reused trigger', async ({ cut, expectedCompactions, expectedOutput }) => {
    const f = fixture()
    f.step('root', 'answer')
    f.usage('root', 'answer', 10)
    f.timing('root', 'answer', 1000)
    f.run('compact', {
      purpose: 'conversation.compaction',
      executionKind: 'maintenance',
      triggeringMessageId: 'goal',
      startedAt: '2026-10-12T00:00:05.000Z',
      completedAt: '2026-10-12T00:00:06.000Z',
      status: 'completed',
    })
    f.usage('compact', 'summary', 7, 'compaction')
    f.event('compact', 'context.compaction.completed', { tokensBefore: 100, estimatedTokensAfter: 30 }, '2026-10-12T00:00:06.000Z')
    f.message('same-time', 'root', 'branch', '2026-10-12T00:00:05.000Z')
    f.message('later-input', 'root', 'branch', '2026-10-12T00:00:10.000Z')
    const parent = await f.service.status(scope.conversationId, scope.branchId)
    expect(parent.tokens.totals.outputTokens).toBe(17)
    expect(parent.activity.compactions.count).toBe(1)

    f.conversations.createBranch({
      id: 'fork',
      conversationId: scope.conversationId,
      parentBranchId: 'branch',
      forkedFromMessageId: cut,
      createdAt: '2026-10-12T00:00:20.000Z',
      activate: false,
    })
    f.run('fork-root', { branchId: 'fork', startedAt: '2026-10-12T00:00:21.000Z' })
    f.conversations.createBranch({
      id: 'descendant',
      conversationId: scope.conversationId,
      parentBranchId: 'fork',
      forkedFromMessageId: 'input-fork-root',
      createdAt: '2026-10-12T00:00:22.000Z',
      activate: false,
    })
    for (const branchId of ['fork', 'descendant']) {
      const timeline = f.conversations.listTimelinePage(scope.conversationId, branchId, { limit: 100 })
      expect(timeline.items.filter(item => item.kind === 'compaction').map(item => item.id)).toEqual(expectedCompactions ? ['compact'] : [])
      const metrics = f.service.metrics({ ...scope, branchId })
      const status = await f.service.status(scope.conversationId, branchId)
      expect(status.activity.compactions.count).toBe(expectedCompactions)
      expect(status.activity.runs.compaction.total).toBe(expectedCompactions)
      expect(status.tokens.totals.outputTokens).toBe(expectedOutput)
      expect(status.tokens.totals).toMatchObject(metrics.tokens)
      expect(status.timing.throughput).toEqual({ samples: 1, tokensPerSecond: 10 })
      expect(metrics.throughput).toEqual(status.timing.throughput)
    }

    f.run('late-compact', {
      purpose: 'conversation.compaction',
      executionKind: 'maintenance',
      triggeringMessageId: 'goal',
      startedAt: '2026-10-12T00:00:15.000Z',
      status: 'completed',
    })
    f.usage('late-compact', 'late-summary', 100, 'compaction')
    f.event('late-compact', 'context.compaction.completed', { tokensBefore: 300, estimatedTokensAfter: 50 }, '2026-10-12T00:00:16.000Z')
    for (const branchId of ['fork', 'descendant']) {
      expect(f.service.metrics({ ...scope, branchId }).tokens.outputTokens).toBe(expectedOutput)
      expect((await f.service.status(scope.conversationId, branchId)).activity.compactions.count).toBe(expectedCompactions)
    }
    expect((await f.service.status(scope.conversationId, scope.branchId)).tokens.totals.outputTokens).toBe(117)
    expect((await f.service.status(scope.conversationId)).activity.compactions.count).toBe(2)
  })

  it('pairs timing with the same run/message usage and never borrows historical output or tools', () => {
    const { service, step, timing, usage, event } = fixture()
    usage('root', 'legacy-without-boundary', 9000)
    event('root', 'tool.started', { toolCallId: 'tool' })
    step('root', 'measured')
    timing('root', 'missing-usage', 1)
    timing('root', 'measured', 1000)
    expect(service.metrics(scope)).toMatchObject({ steps: 1, throughput: { samples: 0, tokensPerSecond: null } })
    usage('root', 'measured', 20)
    expect(service.metrics(scope).throughput).toEqual({ samples: 1, tokensPerSecond: 20 })
    step('root', 'later')
    usage('root', 'later', 60)
    timing('root', 'later', 3000)
    expect(service.metrics(scope).throughput).toEqual({ samples: 2, tokensPerSecond: 20 })
    usage('root', 'measured', 100, 'compaction')
    expect(service.metrics(scope)).toMatchObject({ steps: 2, throughput: { samples: 2, tokensPerSecond: 20 }, tokens: { outputTokens: 9180 } })
    step('root', 'fast')
    usage('root', 'fast', 100)
    timing('root', 'fast', 1000)
    expect(service.metrics(scope).throughput).toEqual({ samples: 3, tokensPerSecond: 36 })
  })

  it('recovers durable facts after restart and preserves cancelled attempts without inventing missing timing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-task-metrics-'))
    try {
      const path = join(directory, 'buddy.sqlite3')
      const { service, database, step, usage, runs, run, timing } = fixture(path)
      run('successful')
      step('successful', 'historical')
      usage('successful', 'historical', 30)
      timing('successful', 'historical', 1500)
      step('root', 'cancelled')
      usage('root', 'cancelled', 3)
      runs.reconcileTerminal('root', 'cancelled', executionNow, null)
      const expected = service.metrics(scope)
      expect(expected).toMatchObject({ turns: 2, steps: 2, throughput: { samples: 1, tokensPerSecond: 20 } })
      const status = await service.status(scope.conversationId, scope.branchId)
      service.dispose()
      database.close()
      databases.splice(databases.indexOf(database), 1)
      const reopened = openBuddyDatabase({ databasePath: path })
      databases.push(reopened)
      const recovered = createMetricsService(reopened)
      expect(recovered.metrics(scope)).toEqual(expected)
      expect(await recovered.status(scope.conversationId, scope.branchId)).toEqual(status)
    }
    finally {
      for (const database of databases.splice(0))
        database.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('excludes incomplete, failed, cancelled, and cross-run pairs from both sides of the weighted rate', async () => {
    const f = fixture()
    f.step('root', 'valid')
    f.usage('root', 'valid', 40)
    f.timing('root', 'valid', 2000)
    f.step('root', 'fast')
    f.usage('root', 'fast', 100)
    f.timing('root', 'fast', 1000)
    for (const id of ['missing-start', 'missing-block', 'missing-end', 'backwards', 'zero', 'failed', 'interrupted', 'cross-run', 'late-start']) {
      f.usage('root', id, 10000)
      if (id !== 'missing-start' && id !== 'late-start')
        f.step('root', id)
    }
    f.timing('root', 'missing-start', 1000)
    f.event('root', 'message.completed', { messageId: 'missing-block' }, '2026-10-12T00:00:10.000Z')
    f.event('root', 'message.block.started', { messageId: 'missing-end' }, '2026-10-12T00:00:01.000Z')
    f.timing('root', 'backwards', -1)
    f.timing('root', 'zero', 0)
    f.timing('root', 'failed', 1000, 'failed')
    f.timing('root', 'interrupted', 1000)
    f.event('root', 'message.interrupted', { messageId: 'interrupted' })
    f.timing('root', 'late-start', 1000)
    f.step('root', 'late-start')
    f.run('other-run')
    f.step('other-run', 'cross-run')
    f.timing('other-run', 'cross-run', 1)
    for (const status of ['failed', 'cancelled'] as const) {
      f.run(status)
      f.step(status, 'failed-request')
      f.usage(status, 'failed-request', 10000)
      f.timing(status, 'failed-request', 1000, 'failed')
      f.runs.reconcileTerminal(status, status, executionNow, null)
    }
    const metrics = f.service.metrics(scope)
    expect(metrics.throughput.samples).toBe(2)
    expect(metrics.throughput.tokensPerSecond).toBeCloseTo(140 / 3)
    expect(metrics.tokens.outputTokens).toBe(110140)
    expect((await f.service.status(scope.conversationId, scope.branchId)).timing.throughput).toEqual(metrics.throughput)
    expect((await f.service.status(scope.conversationId)).timing.throughput).toEqual(metrics.throughput)
  })

  it.each(['failed', 'cancelled'] as const)('retains completed model samples when the product run later becomes %s', async (terminalStatus) => {
    const f = fixture()
    f.step('root', 'successful-request')
    f.usage('root', 'successful-request', 60)
    f.timing('root', 'successful-request', 3000)
    f.step('root', 'failed-request')
    f.usage('root', 'failed-request', 9000)
    f.timing('root', 'failed-request', 1000, 'failed')
    f.step('root', 'interrupted-request')
    f.usage('root', 'interrupted-request', 100)
    f.event('root', 'message.block.started', { messageId: 'interrupted-request' }, '2026-10-12T00:00:01.000Z')
    f.event('root', 'message.interrupted', { messageId: 'interrupted-request' }, '2026-10-12T00:00:05.000Z')
    f.step('root', 'unfinished-request')
    f.usage('root', 'unfinished-request', 1000)
    const before = f.service.metrics(scope)
    expect(before.throughput).toEqual({ samples: 1, tokensPerSecond: 20 })
    f.runs.reconcileTerminal('root', terminalStatus, '2026-10-12T00:00:10.000Z', null)
    const after = f.service.metrics(scope)
    expect(after).toEqual(before)
    expect(after.tokens.outputTokens).toBe(10160)
    for (const branchId of [undefined, scope.branchId]) {
      const status = await f.service.status(scope.conversationId, branchId)
      expect(status.timing.throughput).toEqual(before.throughput)
      expect(status.tokens.totals).toMatchObject({ outputTokens: 10160, recordCount: 4 })
      expect(status.activity.runs.chat[terminalStatus]).toBe(1)
    }
  })

  it('refreshes corrected usage and timing facts without leaking mutations into cached projections', async () => {
    const f = fixture()
    f.step('root', 'measured')
    f.usage('root', 'measured', 20)
    f.timing('root', 'measured', 1000)
    expect(f.service.metrics(scope).throughput).toEqual({ samples: 1, tokensPerSecond: 20 })
    const status = await f.service.status(scope.conversationId, scope.branchId)
    ;(status.timing.throughput as { samples: number }).samples = 99
    f.database.prepare('UPDATE usage_records SET output_tokens = 40, total_tokens = 73 WHERE source_entry_id = \'measured\'').run()
    expect(f.service.metrics(scope).throughput).toEqual({ samples: 1, tokensPerSecond: 40 })
    expect((await f.service.status(scope.conversationId, scope.branchId)).tokens.totals.outputTokens).toBe(40)
    f.database.prepare('UPDATE run_events SET created_at = \'2026-10-12T00:00:03.000Z\' WHERE event_type = \'message.completed\'').run()
    expect(f.service.metrics(scope).throughput).toEqual({ samples: 1, tokensPerSecond: 20 })
    f.database.prepare('DELETE FROM run_events WHERE event_type = \'message.block.started\'').run()
    expect(f.service.metrics(scope).throughput).toEqual({ samples: 0, tokensPerSecond: null })
    expect((await f.service.status(scope.conversationId, scope.branchId)).tokens.totals.outputTokens).toBe(40)
  })

  it('retains tools, model groups, compaction and timing alongside the common token projection', async () => {
    const f = fixture()
    f.event('root', 'run.started', {})
    f.step('root', 'answer')
    f.usage('root', 'answer', 40)
    f.timing('root', 'answer', 2000)
    f.run('npc', { executionKind: 'npc_child', rootRunId: 'root', parentRunId: 'root' })
    f.usage('npc', 'summary', 20, 'compaction')
    f.database.prepare('UPDATE usage_records SET provider = \'second\', model = \'second\', total_cost = 0.5 WHERE run_id = \'npc\'').run()
    for (const runId of ['root', 'npc']) {
      f.event(runId, 'tool.preparing', { toolCallId: 'same-id', toolName: 'read' })
      f.event(runId, 'tool.started', { toolCallId: 'same-id', toolName: 'read' })
      f.event(runId, 'tool.completed', { toolCallId: 'same-id', toolName: 'read', isError: runId === 'npc' }, '2026-10-12T00:00:01.000Z')
    }
    f.event('root', 'tool.denied', { toolCallId: 'denied', toolName: 'bash' })
    f.event('root', 'context.compaction.completed', { tokensBefore: 1000, estimatedTokensAfter: 100 }, '2026-10-12T00:00:04.000Z')
    f.event('npc', 'context.compaction.completed', { tokensBefore: 2000, estimatedTokensAfter: 200 }, '2026-10-12T00:00:03.000Z')
    f.event('root', 'run.completed', {}, '2026-10-12T00:00:10.000Z')
    const status = await f.service.status(scope.conversationId, scope.branchId)
    expect(conversationStatusSchema.parse(status)).toEqual(status)
    expect(status.activity.tools).toEqual({
      denied: 1,
      failed: 1,
      running: 0,
      succeeded: 1,
      total: 3,
      top: [{ name: 'read', count: 2 }, { name: 'bash', count: 1 }],
    })
    expect(status.activity.compactions).toEqual({ count: 2, lastBeforeTokens: 1000, lastAfterTokens: 100 })
    expect(status.timing).toEqual({
      modelMs: 3000,
      toolMs: 2000,
      wallMs: 10000,
      ttft: { samples: 1, averageMs: 1000, maxMs: 1000 },
      throughput: { samples: 1, tokensPerSecond: 20 },
    })
    expect(status.tokens.totals).toMatchObject({ outputTokens: 60, totalCost: 0.5, recordCount: 2 })
    expect(status.tokens.byModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'fixture', modelId: 'fixture', runCount: 1, outputTokens: 40 }),
      expect.objectContaining({ providerId: 'second', modelId: 'second', runCount: 1, outputTokens: 20 }),
    ]))
    expect(f.service.metrics(scope)).toMatchObject({ turns: 1, steps: 1, tokens: { outputTokens: 60 } })
  })

  it('reports independent-only task consumption without fabricating timing or admitting another task', async () => {
    const f = fixture()
    for (const id of ['action-only', 'other']) {
      f.conversations.create({ id, branchId: id, title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: executionNow })
      createExtensionInvocationRepository(f.database).start({ id, conversationId: id, extensionId: 'fixture', actionId: 'fixture', trigger: 'user', startedAt: executionNow })
      f.usage(null, id, 70, 'extension.action', id)
    }
    const status = await f.service.status('action-only')
    expect(status.tokens.totals).toMatchObject({ outputTokens: 70, recordCount: 1 })
    expect(status.tokens.byModel).toMatchObject([{ runCount: 0 }])
    expect(status.activity.runs.chat.total).toBe(0)
    expect(status.timing.throughput).toEqual({ samples: 0, tokensPerSecond: null })
    expect((await f.service.status(scope.conversationId)).tokens.totals.recordCount).toBe(0)
    expect(f.service.metrics({ conversationId: 'action-only', branchId: 'action-only' }).tokens.outputTokens).toBe(0)
  })

  it('rebuilds from facts when the bounded change window expires and after projection replacement', () => {
    const { service, database, step, usage } = fixture()
    service.metrics(scope)
    database.exec('BEGIN')
    for (let index = 0; index < 4100; index++)
      step('root', `message-${index}`)
    database.exec('COMMIT')
    usage('root', 'message-0', 2)
    expect(service.metrics(scope)).toMatchObject({ steps: 4100, tokens: { outputTokens: 2 } })
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.conversation_statistic_changes').get()).toEqual({ count: 4096 })
    database.prepare('DELETE FROM run_events WHERE run_id = \'root\' AND sequence = 1').run()
    expect(service.metrics(scope).steps).toBe(4099)
    step('root', 'message-0')
    expect(service.metrics(scope).steps).toBe(4100)
  })
})
