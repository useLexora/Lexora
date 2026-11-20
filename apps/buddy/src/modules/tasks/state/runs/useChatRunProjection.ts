import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage, LocalMessage, LocalTimelineEventWindow } from '@buddy-shared/conversation/conversationApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBuckets } from '../../model/runs/typing'
import type { ChatRunProjectionState } from './typing'
import { computed, shallowRef } from 'vue'
import {
  hasChatRunEventSequenceGap,
  mergeChatRunEventBuckets,
  mergeChatRunEvents,
} from '../../model/runs/chatRunEventBuckets'
import {
  isRunSignalEvent,
  mergeChangeSets,
  mergeOlderTimelineItems,
  mergeRunOutputs,
  mergeTailTimelineItems,
  reconcileTimelineEventBuckets,
  timelineItemKey,
} from '../../model/runs/chatTimelineMerge'

export function useChatRunProjection() {
  const timelineItems = shallowRef<ReadonlyArray<LocalConversationTimelineItem>>([])
  const messages = computed<ReadonlyArray<LocalMessage>>(() => timelineItems.value.filter(
    (item): item is Extract<LocalConversationTimelineItem, { kind: 'message' }> => item.kind === 'message',
  ))
  const runs = shallowRef<ReadonlyArray<LocalRun>>([])
  const runSignalEvents = shallowRef<ReadonlyArray<LocalRunEvent>>([])
  const runEventBuckets = shallowRef<ChatRunEventBuckets>(new Map())
  const runOutputs = shallowRef<ReadonlyArray<LocalRunOutput>>([])
  const changeSets = shallowRef<ReadonlyArray<LocalChangeSetSummary>>([])
  const approvals = shallowRef<ReadonlyArray<LocalApproval>>([])
  const timelineCursor = shallowRef<string | null>(null)
  const hasOlderMessages = shallowRef(false)
  const knownRunIds = new Set<string>()
  const dirtyRunIds = new Set<string>()
  const loadedWindows = new Map<string, LocalTimelineEventWindow>()
  function commitWindow(window: LocalTimelineEventWindow, events: readonly LocalRunEvent[], mode: 'append' | 'replace' | 'quarantined') {
    const current = runEventBuckets.value
    const next = new Map(current)
    if (mode !== 'append')
      next.delete(window.runId)
    if (mode === 'replace') {
      events = [...events, ...(current.get(window.runId)?.events.filter(event => event.sequence > window.throughSequence) ?? [])]
    }
    const reconciled = reconcileTimelineEventBuckets(next, events, [], new Set([window.runId]))
    runEventBuckets.value = reconciled.buckets
    runSignalEvents.value = reconciled.signals
    loadedWindows.set(window.runId, window)
  }

  let hasLoadedTimelinePage = false
  let snapshotBoundaryKey: string | null = null

  function mergePage(page: LocalConversationTimelinePage) {
    upsertRuns(page.runs)
    const reconciled = reconcileTimelineEventBuckets(
      runEventBuckets.value,
      page.runEvents,
      page.eventWindows ? [] : page.runs,
      dirtyRunIds,
    )
    runSignalEvents.value = reconciled.signals
    runEventBuckets.value = reconciled.buckets
    dirtyRunIds.clear()
    runOutputs.value = mergeRunOutputs(runOutputs.value, page.outputs)
    changeSets.value = mergeChangeSets(changeSets.value, page.changeSets)
  }

  function applySnapshot(page: LocalConversationTimelinePage, pendingApprovals: ReadonlyArray<LocalApproval>) {
    if (!hasLoadedTimelinePage) {
      timelineItems.value = page.items
      timelineCursor.value = page.nextCursor
      hasOlderMessages.value = page.nextCursor !== null
      hasLoadedTimelinePage = true
    }
    else {
      timelineItems.value = mergeTailTimelineItems(timelineItems.value, page.items)
    }
    const tail = page.items.at(-1)
    snapshotBoundaryKey = tail ? timelineItemKey(tail) : null
    mergePage(page)
    approvals.value = pendingApprovals
  }

  function prependPage(page: LocalConversationTimelinePage): boolean {
    const currentIds = new Set(timelineItems.value.map(timelineItemKey))
    const prepended = page.items.some(item => !currentIds.has(timelineItemKey(item)))
    timelineItems.value = mergeOlderTimelineItems(timelineItems.value, page.items)
    mergePage(page)
    timelineCursor.value = page.nextCursor
    hasOlderMessages.value = page.nextCursor !== null
    return prepended
  }

  function appendEvents(incoming: ReadonlyArray<LocalRunEvent>): boolean {
    const sequenceGapDetected = hasChatRunEventSequenceGap(runEventBuckets.value, incoming)
    const signals = incoming.filter(isRunSignalEvent)
    if (signals.length)
      runSignalEvents.value = mergeChatRunEvents(runSignalEvents.value, signals)
    const previous = runEventBuckets.value
    runEventBuckets.value = mergeChatRunEventBuckets(previous, incoming)
    for (const event of incoming) {
      if (runEventBuckets.value.get(event.runId) !== previous.get(event.runId))
        dirtyRunIds.add(event.runId)
    }
    return sequenceGapDetected
  }

  function upsertRuns(incoming: ReadonlyArray<LocalRun>) {
    const byId = new Map(runs.value.map(run => [run.id, run]))
    for (const run of incoming) {
      byId.set(run.id, run)
      knownRunIds.add(run.id)
    }
    runs.value = [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  function upsertMessage(message: LocalMessage) {
    timelineItems.value = mergeTailTimelineItems(timelineItems.value, [{ ...message, kind: 'message' }])
  }

  function getRefreshBoundaryKey(): string | null {
    if (!hasLoadedTimelinePage)
      return snapshotBoundaryKey
    const running = timelineItems.value.find(item => item.kind === 'extension-action' && item.status === 'running')
    return running ? timelineItemKey(running) : snapshotBoundaryKey
  }

  function clear() {
    snapshotBoundaryKey = null
    hasLoadedTimelinePage = false
    timelineCursor.value = null
    hasOlderMessages.value = false
    timelineItems.value = []
    runs.value = []
    runSignalEvents.value = []
    runEventBuckets.value = new Map()
    runOutputs.value = []
    changeSets.value = []
    approvals.value = []
    knownRunIds.clear()
    loadedWindows.clear()
    dirtyRunIds.clear()
  }

  function replaceTurn(run: LocalRun, replacedMessageId: string, retainReplacedMessage: boolean) {
    const replacedIndex = timelineItems.value.findIndex(item => item.kind === 'message' && item.id === replacedMessageId)
    if (replacedIndex < 0) {
      clear()
      upsertRuns([run])
      return
    }
    const retainedTimeline = timelineItems.value.slice(0, replacedIndex + (retainReplacedMessage ? 1 : 0))
    const retainedRunIds = new Set(retainedTimeline.flatMap(item => item.kind === 'message' && item.runId ? [item.runId] : []))
    timelineItems.value = retainedTimeline
    runs.value = runs.value.filter(run => retainedRunIds.has(run.id))
    runSignalEvents.value = runSignalEvents.value.filter(event => retainedRunIds.has(event.runId))
    runEventBuckets.value = new Map([...runEventBuckets.value].filter(([runId]) => retainedRunIds.has(runId)))
    for (const runId of loadedWindows.keys()) {
      if (!retainedRunIds.has(runId))
        loadedWindows.delete(runId)
    }
    for (const runId of dirtyRunIds) {
      if (!retainedRunIds.has(runId))
        dirtyRunIds.delete(runId)
    }
    runOutputs.value = runOutputs.value.filter(output => retainedRunIds.has(output.runId))
    changeSets.value = changeSets.value.filter(changeSet => retainedRunIds.has(changeSet.runId))
    approvals.value = []
    knownRunIds.clear()
    for (const retainedRun of runs.value)
      knownRunIds.add(retainedRun.id)
    hasLoadedTimelinePage = false
    timelineCursor.value = null
    const first = retainedTimeline[0]
    snapshotBoundaryKey = first ? timelineItemKey(first) : null
    upsertRuns([run])
  }

  const state: ChatRunProjectionState = {
    approvals,
    changeSets,
    hasOlderMessages,
    messages,
    runEventBuckets,
    runOutputs,
    runs,
    runSignalEvents,
    timelineItems,
  }

  return {
    state,
    appendEvents,
    applySnapshot,
    loadedWindows,
    commitWindow,
    clear,
    getRefreshBoundaryKey,
    hasRun: (runId: string) => knownRunIds.has(runId),
    prependPage,
    replaceTurn,
    timelineCursor,
    upsertRuns,
    upsertMessage,
  }
}
