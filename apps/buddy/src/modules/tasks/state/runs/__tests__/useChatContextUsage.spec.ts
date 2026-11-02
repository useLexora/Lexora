import type { LocalContextUsageSnapshot, LocalContextUsageSnapshotRequest } from '@buddy-shared/conversation/contextApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useChatContextUsage } from '../useChatContextUsage'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

const model = {
  type: 'chat',
  modelId: 'model',
  providerId: 'provider',
  displayName: 'Model',
  contextWindow: 8192,
} as LocalRuntimeModelOption

function snapshot(tokens: number): LocalContextUsageSnapshot {
  return {
    status: 'ready',
    modelId: 'model',
    providerId: 'provider',
    contextWindow: 8192,
    createdAt: '2026-10-12T00:00:00.000Z',
    totalTokens: tokens,
    messageTokens: tokens,
    mcpTokens: 0,
    skillTokens: 0,
    systemPromptTokens: 0,
    toolTokens: 0,
  }
}

function event(runId: string, tokens = 900): LocalRunEvent {
  return {
    runId,
    sequence: 1,
    type: 'context.usage.updated',
    createdAt: '2026-10-13T00:00:00.000Z',
    payload: { model: 'model', provider: 'provider', totalTokens: tokens, messageTokens: tokens, mcpTokens: 0, skillTokens: 0, systemPromptTokens: 0, toolTokens: 0 },
  }
}

function pending(reason: 'unavailable' | 'compaction' = 'unavailable'): LocalContextUsageSnapshot {
  return { status: 'pending', reason, modelId: 'model', providerId: 'provider', contextWindow: 8192, createdAt: '2026-10-13T00:00:01.000Z' }
}

function setup(thread: string | null = null) {
  const requests: Array<{ input: LocalContextUsageSnapshotRequest, complete: (value: LocalContextUsageSnapshot) => void, reject: (error: Error) => void }> = []
  const actorId = shallowRef<string | null>('actor')
  const runId = shallowRef<string | null>('isolated')
  const threadId = shallowRef<string | null>(thread)
  const selectedModel = shallowRef<LocalRuntimeModelOption | null>(model)
  const runRevision = shallowRef<string | null>(null)
  const activeBranchId = shallowRef<string | null>('branch')
  const activeConversationId = shallowRef<string | null>('conversation')
  const events = shallowRef<readonly LocalRunEvent[]>([event('public')])
  const scope = effectScope()
  const tracker = scope.run(() => useChatContextUsage({
    actorId,
    runId,
    threadId,
    runRevision,
    activeBranchId,
    activeConversationId,
    runSignalEvents: events,
    api: { getUsageSnapshot: input => new Promise((complete, reject) => { requests.push({ input, complete, reject }) }) },
    approvalPolicy: shallowRef('policy'),
    executionProfile: shallowRef('workspace_write'),
    draftId: shallowRef('draft'),
    spaceId: shallowRef(null),
    selectedEffort: shallowRef(null),
    selectedServiceTier: shallowRef(null),
    selectedModel,
    models: shallowRef([model]),
    runtimeState: shallowRef({ status: 'ready' } as LocalBuddyServiceSupervisorState),
  }))!
  cleanups.push(() => {
    tracker.dispose()
    scope.stop()
  })
  return { tracker, requests, actorId, runId, threadId, runRevision, activeBranchId, activeConversationId, events, selectedModel }
}

describe('input context scope', () => {
  it('binds an isolated run and refuses public-thread events before and after its snapshot', async () => {
    const f = setup()
    expect(f.requests[0]!.input).toMatchObject({ actorId: 'actor', runId: 'isolated' })
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 100 })
    f.events.value = [event('public', 900), event('isolated', 110)]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 110 })
  })

  it.each(['actor', 'run', 'branch', 'conversation'] as const)('clears synchronously and rejects stale %s snapshots', async (dimension) => {
    const f = setup()
    const old = f.requests[0]!
    if (dimension === 'actor')
      f.actorId.value = 'another-actor'
    else if (dimension === 'run')
      f.runId.value = 'another-run'
    else if (dimension === 'branch')
      f.activeBranchId.value = 'another-branch'
    else
      f.activeConversationId.value = 'another-conversation'
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    old.complete(snapshot(999))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.requests.at(-1)!.complete(snapshot(200))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 200 })
  })

  it('refreshes from targeted execution revisions even without a child signal event', async () => {
    const f = setup()
    f.requests[0]!.complete(pending())
    await nextTick()
    expect(f.tracker.contextUsage.value?.totalTokens).toBeNull()
    f.runRevision.value = 'updated'
    await nextTick()
    f.requests.at(-1)!.complete(snapshot(300))
    await nextTick()
    expect(f.tracker.contextUsage.value?.totalTokens).toBe(300)
    expect(f.events.value.map(item => item.runId)).toEqual(['public'])
  })

  it('retains the latest usage across idle and new runs of the same thread, then replaces it silently', async () => {
    const f = setup('thread')
    f.events.value = []
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    f.events.value = [event('isolated', 110)]
    f.runId.value = null
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 110 })
    const stale = f.requests.at(-1)!
    f.events.value = []
    f.runId.value = 'next-run'
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 110 })
    stale.complete(snapshot(999))
    f.requests.at(-1)!.complete(pending())
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 110 })
    f.events.value = [event('public', 900), { ...event('next-run', 200), createdAt: '2026-10-13T00:00:02.000Z' }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 200 })
  })

  it.each(['thread', 'actor', 'branch', 'conversation', 'model'] as const)('does not retain ready usage across a different %s', async (dimension) => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    if (dimension === 'thread')
      f.threadId.value = 'isolated-thread'
    else if (dimension === 'actor')
      f.actorId.value = 'other-actor'
    else if (dimension === 'branch')
      f.activeBranchId.value = 'other-branch'
    else if (dimension === 'conversation')
      f.activeConversationId.value = 'other-conversation'
    else
      f.selectedModel.value = { ...model, modelId: 'other-model' }
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.requests.at(-1)!.complete(pending())
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('keeps the last value when a same-scope refresh fails', async () => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    f.runId.value = 'next-run'
    f.requests.at(-1)!.reject(new Error('Temporary read failure'))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 100 })
  })

  it.each(['event', 'snapshot'] as const)('invalidates retained usage after compaction reported by %s', async (source) => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    if (source === 'event') {
      f.events.value = [{ runId: 'isolated', sequence: 2, type: 'context.compaction.completed', createdAt: '2026-10-13T00:00:00.000Z', payload: {} }]
    }
    else {
      f.runRevision.value = 'compacted'
      await nextTick()
      f.requests.at(-1)!.complete(pending('compaction'))
      await nextTick()
    }
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.events.value = []
    f.runId.value = 'next-run'
    f.requests.at(-1)!.complete(pending())
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.events.value = [{ ...event('next-run', 40), createdAt: '2026-10-13T00:00:02.000Z' }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
  })

  it.each(['event', 'snapshot'] as const)('retains recovered usage across same-thread runs after %s compaction', async (source) => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    const compaction: LocalRunEvent = { runId: 'isolated', sequence: 2, type: 'context.compaction.completed', createdAt: '2026-10-13T00:00:01.000Z', payload: {} }
    if (source === 'event') {
      f.events.value = [compaction]
    }
    else {
      f.runRevision.value = 'compacted'
      await nextTick()
      f.requests.at(-1)!.complete(pending('compaction'))
      await nextTick()
    }
    f.events.value = [compaction, { ...event('isolated', 40), sequence: 3, createdAt: compaction.createdAt }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
    f.runId.value = 'next-run'
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
    f.requests.at(-1)!.complete(pending())
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
    f.runId.value = null
    f.events.value = [compaction]
    f.requests.at(-1)!.reject(new Error('Idle preview unavailable'))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
    f.events.value = [{ ...compaction, sequence: 4 }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('rejects an in-flight preview invalidated by compaction and accepts a fresh preview after it', async () => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    f.runRevision.value = 'before-compaction'
    await nextTick()
    const stale = f.requests.at(-1)!
    const compaction: LocalRunEvent = { runId: 'isolated', sequence: 2, type: 'context.compaction.completed', createdAt: '2026-10-13T00:00:02.000Z', payload: {} }
    f.events.value = [compaction]
    stale.complete({ ...snapshot(999), createdAt: '2026-10-13T00:00:03.000Z' })
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.runRevision.value = 'after-compaction'
    await nextTick()
    f.requests.at(-1)!.complete({ ...snapshot(40), createdAt: '2026-10-13T00:00:04.000Z' })
    await nextTick()
    f.events.value = [{ ...compaction }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
  })

  it('does not let an old compaction and its later usage override a newer authoritative compaction', async () => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    f.events.value = [
      { runId: 'isolated', sequence: 1, type: 'context.compaction.completed', createdAt: '2026-10-12T00:00:00.000Z', payload: {} },
      { ...event('isolated', 110), sequence: 2 },
    ]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 110 })
    f.runRevision.value = 'maintenance-compacted'
    await nextTick()
    f.requests.at(-1)!.complete({ ...pending('compaction'), createdAt: '2026-10-14T00:00:00.000Z' })
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('keeps the compaction barrier if the first post-compaction run ends without usage', async () => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    const history: LocalRunEvent[] = [
      { runId: 'isolated', sequence: 1, type: 'context.compaction.completed', createdAt: '2026-10-12T00:00:00.000Z', payload: {} },
      { ...event('isolated', 110), sequence: 2 },
    ]
    f.events.value = history
    f.runRevision.value = 'maintenance-compacted'
    await nextTick()
    f.requests.at(-1)!.complete({ ...pending('compaction'), createdAt: '2026-10-14T00:00:00.000Z' })
    await nextTick()
    f.runId.value = 'next-run'
    f.events.value = []
    f.requests.at(-1)!.complete({ ...pending(), createdAt: '2026-10-15T00:00:00.000Z' })
    await nextTick()
    f.runId.value = null
    f.events.value = history
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
    f.requests.at(-1)!.reject(new Error('Idle preview unavailable'))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('uses a valid model usage event even when an unavailable snapshot has the same timestamp', async () => {
    const f = setup('thread')
    const waiting = pending()
    f.requests[0]!.complete(waiting)
    await nextTick()
    f.events.value = [{ ...event('isolated', 40), createdAt: waiting.createdAt }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
  })

  it('accepts a usage event after compaction in the same millisecond', async () => {
    const f = setup('thread')
    f.requests[0]!.complete(snapshot(100))
    await nextTick()
    const createdAt = '2026-10-13T00:00:02.000Z'
    const compaction: LocalRunEvent = { runId: 'isolated', sequence: 2, type: 'context.compaction.completed', createdAt, payload: {} }
    f.events.value = [compaction]
    expect(f.tracker.contextUsage.value?.status).toBe('pending')
    f.events.value = [compaction, { ...event('isolated', 40), sequence: 3, createdAt }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'ready', totalTokens: 40 })
  })

  it('invalidates a newer local preview when an earlier compaction event arrives late', async () => {
    const f = setup('thread')
    f.requests[0]!.complete({ ...snapshot(100), createdAt: '2026-10-13T00:00:03.000Z' })
    await nextTick()
    f.events.value = [{ runId: 'isolated', sequence: 2, type: 'context.compaction.completed', createdAt: '2026-10-13T00:00:02.000Z', payload: {} }]
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('refreshes an idle thread when maintenance changes its context revision', async () => {
    const f = setup('thread')
    f.events.value = []
    f.runId.value = null
    f.requests.at(-1)!.complete(snapshot(100))
    await nextTick()
    f.runRevision.value = 'maintenance-compacted'
    await nextTick()
    f.requests.at(-1)!.complete(pending('compaction'))
    await nextTick()
    expect(f.tracker.contextUsage.value).toMatchObject({ status: 'pending', totalTokens: null })
  })

  it('preserves ordinary actor event fallback when no execution is targeted and invalidates disposed reads', async () => {
    const f = setup()
    f.runId.value = null
    expect(f.requests.at(-1)!.input.runId).toBeUndefined()
    expect(f.tracker.contextUsage.value?.totalTokens).toBe(900)
    f.runId.value = 'isolated'
    const pending = f.requests.at(-1)!
    f.tracker.dispose()
    pending.complete(snapshot(500))
    await nextTick()
    expect(f.tracker.contextUsage.value?.totalTokens).toBeNull()
  })
})
