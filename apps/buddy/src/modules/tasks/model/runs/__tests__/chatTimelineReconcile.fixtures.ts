import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBuckets } from '../typing'
import { expect } from 'vitest'
import { replaceChatRunEventBuckets } from '../chatRunEventBuckets'
import { flattenRunEventBuckets, isRunSignalEvent, mergeTimelineEvents } from '../chatTimelineMerge'

export function event(runId: string, sequence: number, overrides: Partial<LocalRunEvent> = {}): LocalRunEvent {
  return {
    createdAt: new Date(Date.UTC(2026, 8, 3, 0, 0, sequence)).toISOString(),
    payload: { delta: `${sequence}`, messageId: `assistant-${runId}` },
    runId,
    sequence,
    type: 'message.delta',
    ...overrides,
  }
}

export function run(id: string, status: LocalRun['status'] = 'running'): LocalRun {
  return {
    approvalPolicy: 'policy',
    branchId: 'branch-fixture',
    buddyId: 'default',
    completedAt: null,
    conversationId: 'conversation-fixture',
    errorCode: null,
    executionProfile: 'workspace_write',
    id,
    modelId: 'model-fixture',
    providerId: 'provider-fixture',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-09-03T00:00:00.000Z',
    status,
    triggeringMessageId: `message-${id}`,
  }
}

export function page(runEvents: ReadonlyArray<LocalRunEvent> = [], runs: ReadonlyArray<LocalRun> = []): LocalConversationTimelinePage {
  return { changeSets: [], items: [], nextCursor: null, outputs: [], runEvents, runs }
}

export function legacyReconcile(
  current: ChatRunEventBuckets,
  incoming: LocalConversationTimelinePage,
): { buckets: ChatRunEventBuckets, signals: ReadonlyArray<LocalRunEvent> } {
  const events = mergeTimelineEvents(flattenRunEventBuckets(current), incoming.runEvents, incoming.runs)
  return { buckets: replaceChatRunEventBuckets(events, current), signals: events.filter(isRunSignalEvent) }
}

export function expectEquivalent(
  actual: { buckets: ChatRunEventBuckets, signals: ReadonlyArray<LocalRunEvent> },
  expected: { buckets: ChatRunEventBuckets, signals: ReadonlyArray<LocalRunEvent> },
) {
  expect([...actual.buckets.keys()]).toEqual([...expected.buckets.keys()])
  for (const [runId, bucket] of expected.buckets) {
    const events = actual.buckets.get(runId)!.events
    expect(events).toHaveLength(bucket.events.length)
    bucket.events.forEach((event, index) => expect(events[index]).toBe(event))
  }
  expect(actual.signals).toHaveLength(expected.signals.length)
  expected.signals.forEach((event, index) => expect(actual.signals[index]).toBe(event))
}
