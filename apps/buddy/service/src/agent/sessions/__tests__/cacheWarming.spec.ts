import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { describe, expect, it, vi } from 'vitest'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { openBuddyDatabase } from '../../../storage/database'
import { createUsageRepository } from '../../../storage/usageRepository'
import { UsageService } from '../../../usage/UsageService'
import { PiEventBridge } from '../../events/PiEventBridge'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddySession } from './isolatedBuddySession'

describe('buddy cache warming', () => {
  it.each(['complete', 'disable', 'abort', 'model', 'deadline', 'decision-delay', 'inflight-disable', 'inflight-abort', 'inflight-complete', 'inflight-shutdown', 'unsupported', 'uneconomic', 'missing-prices'] as const)('records native warm usage once and stops on %s', async (stop) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-cache-warming-')))
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    database.exec(`
      INSERT INTO conversations (id, created_at, updated_at) VALUES ('conversation-1', '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z');
      INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch-1', 'conversation-1', '2026-09-21T00:00:00Z');
      INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run-1', 'conversation-1', 'branch-1', 'input-1', 'anthropic', 'fixture', 'chat', 'running', '2026-09-21T00:00:00Z');
    `)
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    const base = runtime.getModels().find(model => model.provider === 'anthropic')!
    const model = { ...base, promptCache: { short: 20, long: 20 }, cost: { input: 100, output: 1, cacheRead: 1, cacheWrite: 100 } }
    if (stop === 'unsupported')
      delete (model as Model<Api>).promptCache
    if (stop === 'uneconomic')
      model.cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
    if (stop === 'missing-prices')
      model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    await runtime.setRuntimeApiKey(model.provider, 'offline-only')
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const finishDecision = Promise.withResolvers<void>()
    const finishWarm = Promise.withResolvers<void>()
    let warmSignal: AbortSignal | undefined
    let warmRequests = 0
    let normalRequests = 0
    vi.spyOn(runtime, 'streamSimple').mockImplementation((target, _context, options) => {
      const warming = options?.maxTokens === 1
      if (warming)
        warmRequests++
      else
        normalRequests++
      if (warming && stop.startsWith('inflight-')) {
        warmSignal = options?.signal
        return response(target, true, false, finishWarm.promise)
      }
      return response(target, warming, !warming && normalRequests === 1)
    })
    const created = await createIsolatedBuddySession({
      agentDir: join(root, 'agent'),
      canonicalRoot: root,
      cwd: root,
      conversationsDirectory: join(root, 'conversations'),
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      model,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resources: { skillReadRoots: [], skillReferences: [], approvedSkillPaths: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
      inProcessExtensions: [{
        name: 'lexora-warm-fixture',
        factory(pi) {
          if (stop === 'decision-delay')
            pi.on('cache_warming_decision', async () => { await finishDecision.promise })
          pi.registerTool({
            name: 'lexora_wait',
            label: 'Wait',
            description: 'Wait for local verification',
            parameters: Type.Object({}),
            async execute(_id, _args, signal) {
              started.resolve()
              signal?.addEventListener('abort', () => finish.resolve(), { once: true })
              await finish.promise
              return { content: [{ type: 'text', text: 'Finished' }], details: {} }
            },
          })
        },
      }],
    })
    const reusable = createReusableBuddySession({
      session: created.session,
      shutdown: created.shutdown,
      assertModelAccess: async () => model,
      runContext: { current: null },
      inputReferences: { pending: null },
      materializeInput: async input => input.prompt,
    })
    const eventLog = createRunEventLog({ database, conversationsDirectory: join(root, 'conversations') })
    const repository = createUsageRepository(database)
    const usage = new UsageService({ repository, eventLog })
    const channel = new PiEventBridge({ eventLog, usage }).createTurn({
      canonicalRoot: root,
      model: model.id,
      provider: model.provider,
      runId: 'run-1',
      session: reusable,
      timestamp: () => new Date().toISOString(),
    })
    const unsubscribe = channel.subscribe()
    let task: Promise<void> | undefined
    try {
      reusable.applyPreferences({ cacheWarming: 'streaming' })
      expect(created.session.settingsManager.getCacheWarmingMode()).toBe('off')
      expect(reusable.getCacheWarmingStatus?.()).toBe(stop === 'unsupported' ? 'unsupported' : 'idle')
      const release = await reusable.activateTurn({
        runId: 'run-1',
        provider: model.provider,
        model: model.id,
        contextWindow: null,
        maxTokens: null,
        signal: new AbortController().signal,
        flushProjectedEvents: () => channel.flush(),
        onToolExecutionAuthorized: async () => {},
        onToolExecutionDenied: async () => {},
      })
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      task = reusable.prompt('Run the waiting tool')
      await started.promise
      expect(reusable.getCacheWarmingStatus?.()).toBe(stop === 'unsupported' ? 'unsupported' : stop === 'missing-prices' ? 'unavailable' : 'scheduled')
      if (stop === 'deadline')
        vi.setSystemTime(Date.now() + 120_000)
      await vi.advanceTimersByTimeAsync(10_000)
      if (stop === 'decision-delay') {
        vi.setSystemTime(Date.now() + 120_000)
        finishDecision.resolve()
        await vi.advanceTimersByTimeAsync(1)
      }
      if (stop === 'unsupported' || stop === 'uneconomic' || stop === 'missing-prices') {
        expect(warmRequests).toBe(0)
        expect(reusable.getCacheWarmingStatus?.()).toBe(stop === 'missing-prices' ? 'unavailable' : stop)
        finish.resolve()
        await task
        release()
        return
      }
      if (stop === 'deadline' || stop === 'decision-delay') {
        expect(warmRequests).toBe(0)
        expect(reusable.getCacheWarmingStatus?.()).toBe('expired')
        expect(repository.listForRun('run-1').filter(record => record.purpose === 'cache_warm')).toEqual([])
        finish.resolve()
        await task
        release()
        return
      }
      if (stop.startsWith('inflight-')) {
        expect(warmRequests).toBe(1)
        expect(reusable.getCacheWarmingStatus?.()).toBe('refreshing')
        if (stop === 'inflight-disable')
          reusable.applyPreferences({ cacheWarming: 'off' })
        if (stop === 'inflight-abort')
          await reusable.abort()
        if (stop === 'inflight-shutdown')
          await reusable.shutdown('quit')
        if (stop === 'inflight-complete') {
          finish.resolve()
          await task
          release()
        }
        expect(warmSignal?.aborted).toBe(true)
        finishWarm.resolve()
        await vi.advanceTimersByTimeAsync(40_000)
        await channel.flush()
        expect(warmRequests).toBe(1)
        expect(repository.listForRun('run-1').filter(record => record.purpose === 'cache_warm')).toEqual([])
        finish.resolve()
        await task
        release()
        return
      }
      await channel.flush()
      const records = repository.listForRun('run-1').filter(record => record.purpose === 'cache_warm')
      expect(warmRequests).toBe(1)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ provider: model.provider, model: model.id, cacheReadTokens: 100_000, outputTokens: 1, totalCost: 0.100001 })
      const entry = created.session.sessionManager.getEntries().find(entry => entry.type === 'usage' && entry.kind === 'cache_warm')!
      expect(created.session.messages.some(message => 'usage' in message && message.usage?.output === 1)).toBe(false)
      expect(await usage.record({ createdAt: records[0]!.createdAt, model: model.id, provider: model.provider, purpose: 'cache_warm', runId: 'run-1', sourceEntryId: entry.id, usage: responseUsage(true) })).toBeNull()
      expect(repository.listForRun('run-1').filter(record => record.purpose === 'cache_warm')).toHaveLength(1)
      if (stop === 'disable')
        reusable.applyPreferences({ cacheWarming: 'off' })
      if (stop === 'abort')
        await reusable.abort()
      if (stop === 'model')
        await created.session.setModel({ ...model, id: 'fixture-next-model' })
      if (stop === 'complete') {
        finish.resolve()
        await task
        release()
      }
      await vi.advanceTimersByTimeAsync(40_000)
      expect(warmRequests).toBe(1)
      finish.resolve()
      await task
      release()
      expect(created.session.cacheWarmingStatus?.state).toBe('inactive')
      await channel.flush()
      expect((await eventLog.list('run-1')).filter(event => event.type === 'usage.recorded' && (event.payload as { purpose?: string }).purpose === 'cache_warm')).toHaveLength(1)
    }
    finally {
      finish.resolve()
      finishDecision.resolve()
      finishWarm.resolve()
      await task
      await channel.settle()
      unsubscribe()
      await created.shutdown('quit')
      vi.useRealTimers()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function responseUsage(warming: boolean) {
  return {
    input: warming ? 0 : 100_000,
    output: warming ? 1 : 5,
    cacheRead: warming ? 100_000 : 0,
    cacheWrite: 0,
    totalTokens: warming ? 100_001 : 100_005,
    cost: { input: warming ? 0 : 10, output: warming ? 0.000001 : 0.000005, cacheRead: warming ? 0.1 : 0, cacheWrite: 0, total: warming ? 0.100001 : 10.000005 },
  }
}

function response(model: Model<Api>, warming: boolean, tool: boolean, gate?: Promise<void>) {
  const message: AssistantMessage = {
    api: model.api,
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    timestamp: Date.now(),
    stopReason: tool ? 'toolUse' : 'stop',
    usage: responseUsage(warming),
    content: tool ? [{ type: 'toolCall', id: 'wait-1', name: 'lexora_wait', arguments: {} }] : [{ type: 'text', text: 'Done' }],
  }
  const stream = createAssistantMessageEventStream()
  void (gate ?? Promise.resolve()).then(() => stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message }))
  return stream
}
