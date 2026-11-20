import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'

import type { ChatRunEventBucket, ChatRunEventBuckets } from './typing'
import { compactChatRunEventSnapshots, mergeChatRunEvents, replaceChatRunEventBuckets } from './chatRunEventBuckets'

interface SnapshotEventOrder {
  readonly event: LocalRunEvent
  readonly key: string
  readonly createdAt: string
  readonly sequence: number
}

interface BucketSnapshotIndex {
  readonly first: SnapshotEventOrder | null
  readonly signals: ReadonlyArray<SnapshotEventOrder>
}

const bucketSnapshotIndexes = new WeakMap<ChatRunEventBucket, BucketSnapshotIndex>()

export function mergeConversationTimelinePages(
  newer: LocalConversationTimelinePage,
  older: LocalConversationTimelinePage,
): LocalConversationTimelinePage {
  return {
    changeSets: mergeChangeSets(older.changeSets, newer.changeSets),
    items: mergeOlderTimelineItems(newer.items, older.items),
    nextCursor: older.nextCursor,
    outputs: mergeRunOutputs(older.outputs, newer.outputs),
    runEvents: mergeTimelineEvents(older.runEvents, newer.runEvents, newer.runs),
    ...(newer.eventWindows && older.eventWindows ? { eventWindows: [...new Map([...older.eventWindows, ...newer.eventWindows].map(window => [window.runId, window])).values()] } : {}),
    runs: [...new Map([...older.runs, ...newer.runs].map(run => [run.id, run])).values()],
  }
}

export function mergeChangeSets(
  current: ReadonlyArray<LocalChangeSetSummary>,
  incoming: ReadonlyArray<LocalChangeSetSummary>,
): ReadonlyArray<LocalChangeSetSummary> {
  const byId = new Map(current.map(changeSet => [changeSet.changeSetId, changeSet]))
  for (const changeSet of incoming)
    byId.set(changeSet.changeSetId, changeSet)
  return [...byId.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
}

export function mergeRunOutputs(
  current: ReadonlyArray<LocalRunOutput>,
  incoming: ReadonlyArray<LocalRunOutput>,
): ReadonlyArray<LocalRunOutput> {
  const byId = new Map(current.map(output => [
    `${output.runId}:${output.sourceToolCallId}`,
    output,
  ]))
  for (const output of incoming)
    byId.set(`${output.runId}:${output.sourceToolCallId}`, output)
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function mergeTailTimelineItems(
  current: ReadonlyArray<LocalConversationTimelineItem>,
  incoming: ReadonlyArray<LocalConversationTimelineItem>,
): ReadonlyArray<LocalConversationTimelineItem> {
  const incomingById = new Map(incoming.map(item => [timelineItemKey(item), item]))
  const currentIds = new Set(current.map(timelineItemKey))
  return [
    ...current.map(item => incomingById.get(timelineItemKey(item)) ?? item),
    ...incoming.filter(item => !currentIds.has(timelineItemKey(item))),
  ]
}

export function mergeOlderTimelineItems(
  current: ReadonlyArray<LocalConversationTimelineItem>,
  incoming: ReadonlyArray<LocalConversationTimelineItem>,
): ReadonlyArray<LocalConversationTimelineItem> {
  const currentIds = new Set(current.map(timelineItemKey))
  return [
    ...incoming.filter(item => !currentIds.has(timelineItemKey(item))),
    ...current,
  ]
}

export function timelineItemKey(item: LocalConversationTimelineItem): string {
  return `${item.kind}:${item.id}`
}

export function mergeTimelineEvents(
  current: ReadonlyArray<LocalRunEvent>,
  incoming: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): ReadonlyArray<LocalRunEvent> {
  const terminalRunIds = new Set(runs.flatMap(run => (
    run.status === 'queued' || run.status === 'running' ? [] : [run.id]
  )))
  return compactChatRunEventSnapshots(
    mergeChatRunEvents(
      current.filter(event => !terminalRunIds.has(event.runId)),
      incoming,
    ),
  )
}

export function reconcileTimelineEventBuckets(
  current: ChatRunEventBuckets,
  incoming: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
  dirtyRunIds: ReadonlySet<string>,
): { buckets: ChatRunEventBuckets, signals: ReadonlyArray<LocalRunEvent> } {
  const terminalRunIds = new Set(runs.flatMap(run => (
    run.status === 'queued' || run.status === 'running' ? [] : [run.id]
  )))
  const affectedRunIds = new Set([...dirtyRunIds, ...terminalRunIds, ...incoming.map(event => event.runId)])
  const runOrders = new Map([...current.keys()].map((runId, index) => [runId, index]))
  const sourceOrders = new Map<string, number>()
  const affectedEvents: LocalRunEvent[] = []
  for (const runId of affectedRunIds) {
    if (terminalRunIds.has(runId))
      continue
    const bucket = current.get(runId)
    if (!bucket)
      continue
    for (const event of bucket.events) {
      sourceOrders.set(`${event.runId}:${event.sequence}`, runOrders.get(runId)!)
      affectedEvents.push(event)
    }
  }
  incoming.forEach((event, index) => {
    const key = `${event.runId}:${event.sequence}`
    if (!sourceOrders.has(key))
      sourceOrders.set(key, current.size + index)
  })
  const reconciled = replaceChatRunEventBuckets(
    compactChatRunEventSnapshots(mergeChatRunEvents(affectedEvents, incoming)),
    current,
  )
  const candidates = new Map(current)
  for (const runId of affectedRunIds)
    candidates.delete(runId)
  for (const [runId, bucket] of reconciled)
    candidates.set(runId, bucket)

  const orderedBuckets: Array<{ runId: string, bucket: ChatRunEventBucket, first: SnapshotEventOrder, order: number }> = []
  const orderedSignals: Array<{ first: SnapshotEventOrder, order: number }> = []
  for (const [runId, bucket] of candidates) {
    const index = getBucketSnapshotIndex(bucket)
    if (!index.first)
      continue
    const sourceOrder = (event: SnapshotEventOrder) => sourceOrders.get(event.key) ?? runOrders.get(runId)!
    orderedBuckets.push({ runId, bucket, first: index.first, order: sourceOrder(index.first) })
    for (const signal of index.signals)
      orderedSignals.push({ first: signal, order: sourceOrder(signal) })
  }
  const compare = (left: { first: SnapshotEventOrder, order: number }, right: { first: SnapshotEventOrder, order: number }) => (
    left.first.createdAt.localeCompare(right.first.createdAt)
    || left.first.sequence - right.first.sequence
    || left.order - right.order
  )
  return {
    buckets: new Map(orderedBuckets.sort(compare).map(({ runId, bucket }) => [runId, bucket])),
    signals: orderedSignals.sort(compare).map(({ first }) => first.event),
  }
}

function getBucketSnapshotIndex(bucket: ChatRunEventBucket): BucketSnapshotIndex {
  const cached = bucketSnapshotIndexes.get(bucket)
  if (cached)
    return cached
  const eventOrder = (event: LocalRunEvent): SnapshotEventOrder => ({
    event,
    key: `${event.runId}:${event.sequence}`,
    createdAt: event.createdAt,
    sequence: event.sequence,
  })
  const events = bucket.events
  const index: BucketSnapshotIndex = {
    first: events[0] ? eventOrder(events[0]) : null,
    signals: events.filter(isRunSignalEvent).map(eventOrder),
  }
  bucketSnapshotIndexes.set(bucket, index)
  return index
}

export function flattenRunEventBuckets(
  buckets: ChatRunEventBuckets,
): ReadonlyArray<LocalRunEvent> {
  return [...buckets.values()].flatMap(bucket => bucket.events)
}

export function isRunSignalEvent(event: LocalRunEvent): boolean {
  if (
    event.type === 'context.compaction.completed'
    || event.type === 'context.usage.updated'
  ) {
    return true
  }
  if (event.type !== 'tool.started')
    return false
  const presentation = event.payload.presentation
  return Boolean(
    presentation
    && typeof presentation === 'object'
    && 'card' in presentation
    && presentation.card === 'browser'
    && 'operation' in presentation
    && presentation.operation === 'open',
  )
}
