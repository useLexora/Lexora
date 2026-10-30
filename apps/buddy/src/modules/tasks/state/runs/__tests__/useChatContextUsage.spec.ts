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

function setup() {
  const requests: Array<{ input: LocalContextUsageSnapshotRequest, complete: (value: LocalContextUsageSnapshot) => void }> = []
  const actorId = shallowRef<string | null>('actor')
  const runId = shallowRef<string | null>('isolated')
  const runRevision = shallowRef<string | null>(null)
  const activeBranchId = shallowRef<string | null>('branch')
  const activeConversationId = shallowRef<string | null>('conversation')
  const events = shallowRef<readonly LocalRunEvent[]>([event('public')])
  const scope = effectScope()
  const tracker = scope.run(() => useChatContextUsage({
    actorId,
    runId,
    runRevision,
    activeBranchId,
    activeConversationId,
    runSignalEvents: events,
    api: { getUsageSnapshot: input => new Promise((complete) => { requests.push({ input, complete }) }) },
    approvalPolicy: shallowRef('policy'),
    executionProfile: shallowRef('workspace_write'),
    draftId: shallowRef('draft'),
    spaceId: shallowRef(null),
    selectedEffort: shallowRef(null),
    selectedServiceTier: shallowRef(null),
    selectedModel: shallowRef(model),
    models: shallowRef([model]),
    runtimeState: shallowRef({ status: 'ready' } as LocalBuddyServiceSupervisorState),
  }))!
  cleanups.push(() => {
    tracker.dispose()
    scope.stop()
  })
  return { tracker, requests, actorId, runId, runRevision, activeBranchId, activeConversationId, events }
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
    f.requests[0]!.complete({ status: 'pending', modelId: 'model', providerId: 'provider', contextWindow: 8192, createdAt: '2026-10-12T00:00:00.000Z' })
    await nextTick()
    expect(f.tracker.contextUsage.value?.totalTokens).toBeNull()
    f.runRevision.value = 'updated'
    await nextTick()
    f.requests.at(-1)!.complete(snapshot(300))
    await nextTick()
    expect(f.tracker.contextUsage.value?.totalTokens).toBe(300)
    expect(f.events.value.map(item => item.runId)).toEqual(['public'])
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
