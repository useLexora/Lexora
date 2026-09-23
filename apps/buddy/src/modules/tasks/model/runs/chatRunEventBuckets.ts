import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBucket, ChatRunEventBuckets } from './typing'

interface ChatRunEventChunk {
  readonly events: ReadonlyArray<LocalRunEvent>
  readonly previous: ChatRunEventChunk | null
}

interface ChatRunEventBucketState {
  readonly completedToolKeys: ReadonlySet<string>
  flattenedEvents: ReadonlyArray<LocalRunEvent> | null
  readonly lastCreatedAt: string | null
  readonly lastSequence: number
  readonly maxSequence: number
  readonly tail: ChatRunEventChunk | null
}

let nextRevision = 0
const bucketStates = new WeakMap<ChatRunEventBucket, ChatRunEventBucketState>()

export function replaceChatRunEventBuckets(
  events: ReadonlyArray<LocalRunEvent>,
  current: ChatRunEventBuckets = new Map(),
): ChatRunEventBuckets {
  return new Map([...indexRunEvents(events)].map(([runId, runEvents]) => {
    const compacted = compactChatRunEventSnapshots(mergeChatRunEvents([], runEvents))
    const previous = current.get(runId)
    return [runId, previous && hasSameEventReferences(previous.events, compacted)
      ? previous
      : createBucket(compacted, null)]
  }))
}

export function mergeChatRunEventBuckets(
  current: ChatRunEventBuckets,
  incoming: ReadonlyArray<LocalRunEvent>,
): ChatRunEventBuckets {
  let next: Map<string, ChatRunEventBucket> | null = null
  for (const [runId, events] of indexRunEvents(incoming)) {
    const previous = current.get(runId)
    if (!previous) {
      next ??= new Map(current)
      next.set(runId, createBucket(
        compactChatRunEventSnapshots(mergeChatRunEvents([], events)),
        null,
      ))
      continue
    }
    const previousState = bucketStates.get(previous)
    if (previousState && canAppendEvents(previousState, events)) {
      next ??= new Map(current)
      next.set(runId, appendBucket(previous, previousState, events))
      continue
    }
    const merged = mergeChatRunEvents(previous.events, events)
    const appendedEvents = isAppendedEventSuffix(previous.events, merged)
      ? merged.slice(previous.events.length)
      : null
    const compacted = compactChatRunEventSnapshots(merged)
    if (hasSameEventReferences(previous.events, compacted))
      continue
    const update = appendedEvents
      ? {
          events: appendedEvents,
          kind: 'append' as const,
          previousRevision: previous.revision,
        }
      : null
    next ??= new Map(current)
    next.set(runId, createBucket(compacted, update))
  }
  return next ?? current
}

export function hasChatRunEventSequenceGap(
  current: ChatRunEventBuckets,
  incoming: ReadonlyArray<LocalRunEvent>,
): boolean {
  for (const [runId, events] of indexRunEvents(incoming)) {
    const bucket = current.get(runId)
    const state = bucket ? bucketStates.get(bucket) : undefined
    let sequence = state?.maxSequence
      ?? bucket?.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0)
      ?? 0
    const incomingSequences = [...new Set(events.map(event => event.sequence))]
      .filter(candidate => candidate > sequence)
      .sort((left, right) => left - right)
    for (const candidate of incomingSequences) {
      if (candidate !== sequence + 1)
        return true
      sequence = candidate
    }
  }
  return false
}

export function mergeChatRunEvents(
  current: ReadonlyArray<LocalRunEvent>,
  incoming: ReadonlyArray<LocalRunEvent>,
): ReadonlyArray<LocalRunEvent> {
  const byId = new Map(current.map(event => [`${event.runId}:${event.sequence}`, event]))
  for (const event of incoming)
    byId.set(`${event.runId}:${event.sequence}`, event)
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.sequence - right.sequence)
}

export function compactChatRunEventSnapshots(
  events: ReadonlyArray<LocalRunEvent>,
): ReadonlyArray<LocalRunEvent> {
  const isTerminalRun = events.some(event =>
    event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled',
  )
  const completedToolKeys = new Set<string>()
  const startedOrCompletedToolKeys = new Set<string>()
  const latestToolReplacementSequence = new Map<string, number>()
  for (const event of events) {
    const toolKey = runToolKey(event)
    if (!toolKey)
      continue
    if (event.type === 'tool.completed')
      completedToolKeys.add(toolKey)
    if (event.type === 'tool.started' || event.type === 'tool.completed')
      startedOrCompletedToolKeys.add(toolKey)
    else if (event.type === 'tool.updated' && !isToolPresentationDelta(event))
      latestToolReplacementSequence.set(toolKey, event.sequence)
  }
  return events.filter((event) => {
    if (isTerminalRun && event.type === 'run.progress')
      return false
    if (event.type === 'tool.preparing') {
      const toolKey = runToolKey(event)
      return toolKey ? !startedOrCompletedToolKeys.has(toolKey) : true
    }
    if (event.type !== 'tool.updated')
      return true
    const toolKey = runToolKey(event)
    if (toolKey === null)
      return true
    if (completedToolKeys.has(toolKey))
      return false
    const latestReplacementSequence = latestToolReplacementSequence.get(toolKey)
    return isToolPresentationDelta(event)
      ? latestReplacementSequence === undefined || event.sequence > latestReplacementSequence
      : latestReplacementSequence === event.sequence
  })
}

function isToolPresentationDelta(event: LocalRunEvent): boolean {
  return event.type === 'tool.updated'
    && typeof event.payload.presentationDelta === 'object'
    && event.payload.presentationDelta !== null
}

function createBucket(
  events: ReadonlyArray<LocalRunEvent>,
  update: ChatRunEventBucket['update'],
): ChatRunEventBucket {
  return createBucketWithState(createBucketState(events), update)
}

function createBucketWithState(
  state: ChatRunEventBucketState,
  update: ChatRunEventBucket['update'],
): ChatRunEventBucket {
  nextRevision += 1
  const bucket: ChatRunEventBucket = {
    get events() {
      return materializeBucketEvents(state)
    },
    revision: nextRevision,
    update,
  }
  bucketStates.set(bucket, state)
  return bucket
}

function createBucketState(
  events: ReadonlyArray<LocalRunEvent>,
): ChatRunEventBucketState {
  const lastEvent = events.at(-1)
  return {
    completedToolKeys: new Set(events.flatMap((event) => {
      const toolKey = event.type === 'tool.completed' ? runToolKey(event) : null
      return toolKey ? [toolKey] : []
    })),
    flattenedEvents: events,
    lastCreatedAt: lastEvent?.createdAt ?? null,
    lastSequence: lastEvent?.sequence ?? -1,
    maxSequence: events.reduce(
      (maximum, event) => Math.max(maximum, event.sequence),
      -1,
    ),
    tail: events.length > 0 ? { events, previous: null } : null,
  }
}

function appendBucket(
  previous: ChatRunEventBucket,
  previousState: ChatRunEventBucketState,
  events: ReadonlyArray<LocalRunEvent>,
): ChatRunEventBucket {
  const lastEvent = events.at(-1)!
  return createBucketWithState({
    completedToolKeys: previousState.completedToolKeys,
    flattenedEvents: null,
    lastCreatedAt: lastEvent.createdAt,
    lastSequence: lastEvent.sequence,
    maxSequence: lastEvent.sequence,
    tail: { events, previous: previousState.tail },
  }, {
    events,
    kind: 'append',
    previousRevision: previous.revision,
  })
}

function canAppendEvents(
  state: ChatRunEventBucketState,
  events: ReadonlyArray<LocalRunEvent>,
): boolean {
  let lastCreatedAt = state.lastCreatedAt
  let lastSequence = state.lastSequence
  let maxSequence = state.maxSequence
  for (const event of events) {
    const createdAt = event.createdAt
    if (
      event.sequence <= maxSequence
      || isBeforeOrEqual(createdAt, event.sequence, lastCreatedAt, lastSequence)
      || requiresEventReconciliation(event, state.completedToolKeys)
    ) {
      return false
    }
    lastCreatedAt = createdAt
    lastSequence = event.sequence
    maxSequence = event.sequence
  }
  return events.length > 0
}

function isBeforeOrEqual(
  createdAt: string,
  sequence: number,
  previousCreatedAt: string | null,
  previousSequence: number,
): boolean {
  if (previousCreatedAt === null)
    return false
  const createdAtOrder = createdAt.localeCompare(previousCreatedAt)
  return createdAtOrder < 0 || (createdAtOrder === 0 && sequence <= previousSequence)
}

function requiresEventReconciliation(
  event: LocalRunEvent,
  completedToolKeys: ReadonlySet<string>,
): boolean {
  if (event.type === 'tool.completed')
    return true
  if (event.type !== 'tool.updated')
    return false
  if (!isToolPresentationDelta(event))
    return true
  const toolKey = runToolKey(event)
  return toolKey !== null && completedToolKeys.has(toolKey)
}

function materializeBucketEvents(
  state: ChatRunEventBucketState,
): ReadonlyArray<LocalRunEvent> {
  if (state.flattenedEvents)
    return state.flattenedEvents
  const chunks: ChatRunEventChunk[] = []
  for (let chunk = state.tail; chunk; chunk = chunk.previous)
    chunks.push(chunk)
  const events: LocalRunEvent[] = []
  for (const chunk of chunks.reverse()) {
    for (const event of chunk.events)
      events.push(event)
  }
  state.flattenedEvents = events
  return events
}

function indexRunEvents(
  events: ReadonlyArray<LocalRunEvent>,
): ReadonlyMap<string, ReadonlyArray<LocalRunEvent>> {
  const eventsByRunId = new Map<string, LocalRunEvent[]>()
  for (const event of events) {
    const runEvents = eventsByRunId.get(event.runId) ?? []
    runEvents.push(event)
    eventsByRunId.set(event.runId, runEvents)
  }
  return eventsByRunId
}

function hasSameEventReferences(
  previous: ReadonlyArray<LocalRunEvent>,
  current: ReadonlyArray<LocalRunEvent>,
): boolean {
  return previous.length === current.length
    && previous.every((event, index) => current[index] === event)
}

function isAppendedEventSuffix(
  previous: ReadonlyArray<LocalRunEvent>,
  current: ReadonlyArray<LocalRunEvent>,
): boolean {
  return current.length > previous.length
    && previous.every((event, index) => current[index] === event)
}

function runToolKey(event: LocalRunEvent): string | null {
  const toolCallId = event.payload.toolCallId
  return typeof toolCallId === 'string' && toolCallId
    ? `${event.runId}:${toolCallId}`
    : null
}
