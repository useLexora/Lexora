import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBucket, ChatRunEventBuckets } from '../../model/runs/typing'
import type { ChatRunProjectionState } from './typing'
import { computed, shallowReactive, shallowRef } from 'vue'
import { projectChatRunStreamingMessages } from '../../model/transcript/chatRunStreamingMessages'
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
  const runs = shallowRef<ReadonlyArray<LocalRun>>([])
  const runSignalEvents = shallowRef<ReadonlyArray<LocalRunEvent>>([])
  const runEventBuckets = shallowRef<ChatRunEventBuckets>(new Map())
  const runOutputs = shallowRef<ReadonlyArray<LocalRunOutput>>([])
  const changeSets = shallowRef<ReadonlyArray<LocalChangeSetSummary>>([])
  const approvals = shallowRef<ReadonlyArray<LocalApproval>>([])
  const timelineCursor = shallowRef<string | null>(null)
  const hasOlderMessages = computed(() => timelineCursor.value !== null)
  const knownRunIds = new Set<string>()
  // Presentation stops immediately; authoritative runs still own execution until cleanup finishes.
  const cancelledPresentations = shallowReactive(new Map<string, {
    run: LocalRun
    bucket: ChatRunEventBucket
    messages: ReadonlyMap<string, LocalConversationTimelineItem>
  }>())
  let hasLoadedTimelinePage = false

  const presentedRuns = computed(() => runs.value.map(run => cancelledPresentations.get(run.id)?.run ?? run))
  const presentedBuckets = computed<ChatRunEventBuckets>(() => {
    if (!cancelledPresentations.size)
      return runEventBuckets.value
    const buckets = new Map(runEventBuckets.value)
    for (const [runId, presentation] of cancelledPresentations) {
      if (knownRunIds.has(runId))
        buckets.set(runId, presentation.bucket)
    }
    return buckets
  })
  const presentedTimeline = computed(() => {
    const items = timelineItems.value.flatMap((item) => {
      if (item.kind !== 'message' || !item.runId)
        return [item]
      const presentation = cancelledPresentations.get(item.runId)
      if (!presentation)
        return [item]
      const frozen = presentation.messages.get(item.id)
      return frozen ? [frozen] : []
    })
    const frozenMessages = [...cancelledPresentations].flatMap(([runId, presentation]) =>
      knownRunIds.has(runId) ? [...presentation.messages.values()] : [])
    return mergeTailTimelineItems(items, frozenMessages)
  })

  function cancelRunPresentation(runId: string) {
    const run = runs.value.find(run => run.id === runId)
    if (!run || (run.status !== 'queued' && run.status !== 'running') || cancelledPresentations.has(runId))
      return
    const completedAt = new Date().toISOString()
    const bucket = runEventBuckets.value.get(runId)
    const events = bucket?.events ?? []
    // Keep the visible partial answer when terminal projection stops accepting streaming deltas.
    const messages = new Map<string, LocalConversationTimelineItem>(timelineItems.value.flatMap(item =>
      item.kind === 'message' && item.runId === runId ? [[item.id, item] as const] : []))
    for (const candidate of projectChatRunStreamingMessages(run, events)) {
      if (!messages.has(candidate.message.id))
        messages.set(candidate.message.id, { ...candidate.message, kind: 'message' })
    }
    cancelledPresentations.set(runId, {
      run: { ...run, status: 'cancelled', completedAt, errorCode: 'RUN_CANCELLED' },
      bucket: { events, revision: (bucket?.revision ?? 0) + 1, update: null },
      messages,
    })
  }

  function restoreRunPresentation(runId: string) {
    cancelledPresentations.delete(runId)
  }

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
    approvals.value = pendingApprovals.filter(approval => knownRunIds.has(approval.runId))
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
      if (run.status !== 'queued' && run.status !== 'running')
        restoreRunPresentation(run.id)
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
    approvals: computed(() => approvals.value.filter(approval => !cancelledPresentations.has(approval.runId))),
    changeSets,
    hasOlderMessages,
    messages: computed(() => presentedTimeline.value.filter((item): item is Extract<LocalConversationTimelineItem, { kind: 'message' }> => item.kind === 'message')),
    runEventBuckets: presentedBuckets,
    runOutputs,
    runs: presentedRuns,
    runSignalEvents,
    timelineItems: presentedTimeline,
  }

  return {
    state,
    executionRuns: runs,
    cancelRunPresentation,
    restoreRunPresentation,
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
