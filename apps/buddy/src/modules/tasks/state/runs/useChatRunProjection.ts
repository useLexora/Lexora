import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBuckets } from '../../model/runs/typing'
import type { ChatRunProjectionState } from './typing'
import { computed, shallowRef } from 'vue'
import {
  hasChatRunEventSequenceGap,
  mergeChatRunEventBuckets,
  mergeChatRunEvents,
  replaceChatRunEventBuckets,
} from '../../model/runs/chatRunEventBuckets'
import {
  flattenRunEventBuckets,
  isRunSignalEvent,
  mergeChangeSets,
  mergeOlderTimelineItems,
  mergeRunOutputs,
  mergeTailTimelineItems,
  mergeTimelineEvents,
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
  const hasOlderMessages = computed(() => timelineCursor.value !== null)
  const knownRunIds = new Set<string>()
  let hasLoadedTimelinePage = false

  function mergePage(page: LocalConversationTimelinePage) {
    upsertRuns(page.runs)
    const events = mergeTimelineEvents(
      flattenRunEventBuckets(runEventBuckets.value),
      page.runEvents,
      page.runs,
    )
    runSignalEvents.value = events.filter(isRunSignalEvent)
    runEventBuckets.value = replaceChatRunEventBuckets(events, runEventBuckets.value)
    runOutputs.value = mergeRunOutputs(runOutputs.value, page.outputs)
    changeSets.value = mergeChangeSets(changeSets.value, page.changeSets)
  }

  function applySnapshot(page: LocalConversationTimelinePage, pendingApprovals: ReadonlyArray<LocalApproval>) {
    if (!hasLoadedTimelinePage) {
      timelineItems.value = page.items
      timelineCursor.value = page.nextCursor
      hasLoadedTimelinePage = true
    }
    else {
      timelineItems.value = mergeTailTimelineItems(timelineItems.value, page.items)
    }
    mergePage(page)
    approvals.value = pendingApprovals
  }

  function prependPage(page: LocalConversationTimelinePage): boolean {
    const currentIds = new Set(timelineItems.value.map(timelineItemKey))
    const prepended = page.items.some(item => !currentIds.has(timelineItemKey(item)))
    timelineItems.value = mergeOlderTimelineItems(timelineItems.value, page.items)
    mergePage(page)
    timelineCursor.value = page.nextCursor
    return prepended
  }

  function appendEvents(incoming: ReadonlyArray<LocalRunEvent>): boolean {
    const sequenceGapDetected = hasChatRunEventSequenceGap(runEventBuckets.value, incoming)
    const signals = incoming.filter(isRunSignalEvent)
    if (signals.length)
      runSignalEvents.value = mergeChatRunEvents(runSignalEvents.value, signals)
    runEventBuckets.value = mergeChatRunEventBuckets(runEventBuckets.value, incoming)
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

  function clear(retainedTimeline: ReadonlyArray<LocalConversationTimelineItem> = []) {
    hasLoadedTimelinePage = false
    timelineCursor.value = null
    timelineItems.value = retainedTimeline
    runs.value = []
    runSignalEvents.value = []
    runEventBuckets.value = new Map()
    runOutputs.value = []
    changeSets.value = []
    approvals.value = []
    knownRunIds.clear()
  }

  function replaceTurn(run: LocalRun, replacedMessageId: string, retainReplacedMessage: boolean) {
    const replacedIndex = timelineItems.value.findIndex(item => item.kind === 'message' && item.id === replacedMessageId)
    const retainedTimeline = replacedIndex < 0
      ? []
      : timelineItems.value.slice(0, replacedIndex + (retainReplacedMessage ? 1 : 0))
    clear(retainedTimeline)
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
    clear,
    hasRun: (runId: string) => knownRunIds.has(runId),
    prependPage,
    replaceTurn,
    timelineCursor,
    upsertRuns,
  }
}
