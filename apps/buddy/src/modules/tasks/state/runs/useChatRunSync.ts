import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunSync, ChatRunSyncOptions } from './typing'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { mergeConversationTimelinePages, timelineItemKey } from '../../model/runs/chatTimelineMerge'
import { useChatRunProjection } from './useChatRunProjection'

const TIMELINE_PAGE_SIZE = 100
const RECENT_TIMELINE_RANGE_COUNT = 20
const SNAPSHOT_RECONCILIATION_EVENT_TYPES = new Set([
  'approval.requested',
  'approval.resolved',
  'message.completed',
  'output.produced',
  'run.cancelled',
  'run.completed',
  'run.failed',
])

interface ProjectionRequest {
  branchId: string
  conversationId: string
  generation: number
}

interface RefreshFlight {
  dirty: boolean
  promise: Promise<void>
  request: ProjectionRequest
}

export function useChatRunSync(options: ChatRunSyncOptions): ChatRunSync {
  const projection = useChatRunProjection()
  const isLoadingOlderMessages = shallowRef(false)
  const settledScopeKey = shallowRef<string | null>(null)
  const scopeKey = computed(() => options.activeConversationId.value && options.activeBranchId.value
    ? `${options.activeConversationId.value}:${options.activeBranchId.value}`
    : null)
  const isLoadingConversation = computed(() => options.activeConversationId.value !== null
    && (scopeKey.value === null || settledScopeKey.value !== scopeKey.value))
  const loadedRanges = new Map<string, string>()
  let loadedBranchId: string | null = null
  let loadedConversationId: string | null = null
  let generation = 0
  let disposed = false
  let refreshFlight: RefreshFlight | null = null
  let refreshTimer: number | null = null
  let runEventCommitFrame: number | null = null
  let pendingRunEvents: LocalRunEvent[] = []

  const stopScopeWatch = watch(
    [options.activeConversationId, options.activeBranchId],
    invalidatePendingWork,
    { flush: 'sync' },
  )
  onScopeDispose(dispose, true)

  function isActive(conversationId: string, branchId: string): boolean {
    return !disposed
      && conversationId === options.activeConversationId.value
      && branchId === options.activeBranchId.value
  }

  function currentRequest(): ProjectionRequest | null {
    if (!loadedConversationId || !loadedBranchId || !isActive(loadedConversationId, loadedBranchId))
      return null
    return { branchId: loadedBranchId, conversationId: loadedConversationId, generation }
  }

  function isCurrent(request: ProjectionRequest): boolean {
    return request.generation === generation && isActive(request.conversationId, request.branchId)
  }

  function selectProjection(conversationId: string, branchId: string) {
    if (loadedConversationId === conversationId && loadedBranchId === branchId)
      return
    invalidatePendingWork()
    settledScopeKey.value = null
    projection.clear()
    loadedConversationId = conversationId
    loadedBranchId = branchId
  }

  async function refreshActiveConversation(): Promise<void> {
    if (disposed)
      return
    const conversationId = options.activeConversationId.value
    const branchId = options.activeBranchId.value
    if (!conversationId || !branchId) {
      clearConversationState()
      return
    }
    selectProjection(conversationId, branchId)
    if (refreshFlight) {
      refreshFlight.dirty = true
      return refreshFlight.promise
    }
    const flight: RefreshFlight = {
      dirty: false,
      promise: Promise.resolve(),
      request: { branchId, conversationId, generation },
    }
    flight.promise = drainRefreshFlight(flight).finally(() => {
      if (refreshFlight === flight)
        refreshFlight = null
    })
    refreshFlight = flight
    return flight.promise
  }

  async function drainRefreshFlight(flight: RefreshFlight): Promise<void> {
    do {
      flight.dirty = false
      await refreshSnapshot(flight.request)
    } while (flight.dirty && isCurrent(flight.request))
  }

  async function refreshSnapshot(request: ProjectionRequest): Promise<void> {
    try {
      const [latest, approvals] = await Promise.all([
        options.api.conversations.listTimeline({
          branchId: request.branchId,
          conversationId: request.conversationId,
          limit: TIMELINE_PAGE_SIZE,
        }),
        options.api.approvals.list({ limit: 100, status: 'pending' }),
      ])
      if (!isCurrent(request))
        return
      let page = latest
      const refreshBoundary = projection.state.timelineItems.value.find(item => item.kind === 'extension-action' && item.status === 'running')
        ?? projection.state.timelineItems.value.at(-1)
      const rememberedStart = refreshBoundary
        ? timelineItemKey(refreshBoundary)
        : loadedRanges.get(`${request.conversationId}:${request.branchId}`)
      while (page.nextCursor) {
        if (!rememberedStart || page.items.some(item => timelineItemKey(item) === rememberedStart))
          break
        const older = await options.api.conversations.listTimeline({
          branchId: request.branchId,
          conversationId: request.conversationId,
          cursor: page.nextCursor,
          limit: TIMELINE_PAGE_SIZE,
        })
        if (!isCurrent(request))
          return
        page = mergeConversationTimelinePages(page, older)
      }
      if (isCurrent(request)) {
        projection.applySnapshot(page, approvals)
        rememberLoadedRange(request)
      }
    }
    catch (error) {
      if (isCurrent(request))
        options.onError(error)
    }
    finally {
      if (isCurrent(request))
        settledScopeKey.value = `${request.conversationId}:${request.branchId}`
    }
  }

  function rememberLoadedRange(request: ProjectionRequest) {
    const first = projection.state.timelineItems.value[0]
    if (!first)
      return
    const key = `${request.conversationId}:${request.branchId}`
    loadedRanges.delete(key)
    loadedRanges.set(key, timelineItemKey(first))
    if (loadedRanges.size > RECENT_TIMELINE_RANGE_COUNT)
      loadedRanges.delete(loadedRanges.keys().next().value!)
  }

  async function loadOlderMessages(): Promise<boolean> {
    const request = currentRequest()
    const cursor = projection.timelineCursor.value
    if (!request || !cursor || isLoadingOlderMessages.value)
      return false
    isLoadingOlderMessages.value = true
    try {
      const page = await options.api.conversations.listTimeline({
        branchId: request.branchId,
        conversationId: request.conversationId,
        cursor,
        limit: TIMELINE_PAGE_SIZE,
      })
      if (!isCurrent(request) || projection.timelineCursor.value !== cursor)
        return false
      const prepended = projection.prependPage(page)
      rememberLoadedRange(request)
      return prepended
    }
    catch (error) {
      if (isCurrent(request))
        options.onError(error)
      return false
    }
    finally {
      if (isCurrent(request))
        isLoadingOlderMessages.value = false
    }
  }

  function handleRunEvent(event: LocalRunEvent) {
    const request = currentRequest()
    if (!request || !projection.hasRun(event.runId))
      return
    pendingRunEvents.push(event)
    if (SNAPSHOT_RECONCILIATION_EVENT_TYPES.has(event.type)) {
      cancelEventFrame()
      commitPendingRunEvents(request)
      scheduleRefresh()
    }
    else if (runEventCommitFrame === null) {
      runEventCommitFrame = window.requestAnimationFrame(() => {
        runEventCommitFrame = null
        commitPendingRunEvents(request)
      })
    }
  }

  function commitPendingRunEvents(request: ProjectionRequest) {
    if (!isCurrent(request) || pendingRunEvents.length === 0)
      return
    const incoming = pendingRunEvents
    pendingRunEvents = []
    if (projection.appendEvents(incoming))
      scheduleRefresh()
  }

  function scheduleRefresh() {
    const request = currentRequest()
    if (!request || refreshTimer !== null)
      return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      if (isCurrent(request))
        void refreshActiveConversation()
    }, 100)
  }

  function applyRunStart(turn: LocalTurnStart) {
    if (!isActive(turn.conversationId, turn.branchId))
      return
    selectProjection(turn.conversationId, turn.branchId)
    projection.upsertRuns([turn.run])
    scheduleRefresh()
  }

  function applyReplacementTurn(turn: LocalTurnStart, messageId: string, retainMessage: boolean) {
    if (!isActive(turn.conversationId, turn.branchId))
      return
    invalidatePendingWork()
    loadedRanges.delete(`${turn.conversationId}:${turn.branchId}`)
    projection.replaceTurn(turn.run, messageId, retainMessage)
    loadedConversationId = turn.conversationId
    loadedBranchId = turn.branchId
    scheduleRefresh()
  }

  function upsertRuns(incoming: ReadonlyArray<LocalRun>) {
    const request = currentRequest()
    if (!request)
      return
    const applicable = incoming.filter(run => run.conversationId === request.conversationId
      && (run.branchId === request.branchId || projection.hasRun(run.id)))
    if (applicable.length)
      projection.upsertRuns(applicable)
  }

  function clearConversationState() {
    if (disposed)
      return
    invalidatePendingWork()
    loadedConversationId = null
    loadedBranchId = null
    settledScopeKey.value = null
    projection.clear()
  }

  function cancelEventFrame() {
    if (runEventCommitFrame !== null)
      window.cancelAnimationFrame(runEventCommitFrame)
    runEventCommitFrame = null
  }

  function invalidatePendingWork() {
    generation += 1
    refreshFlight = null
    isLoadingOlderMessages.value = false
    pendingRunEvents = []
    cancelEventFrame()
    if (refreshTimer !== null)
      window.clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function dispose() {
    if (disposed)
      return
    disposed = true
    stopScopeWatch()
    loadedRanges.clear()
    invalidatePendingWork()
  }

  return {
    ...projection.state,
    applyEditedTurn: (turn, messageId) => applyReplacementTurn(turn, messageId, false),
    applyRegeneratedTurn: turn => applyReplacementTurn(turn, turn.run.triggeringMessageId, true),
    applyRunStart,
    clearConversationState,
    dispose,
    handleRunEvent,
    isLoadingOlderMessages,
    isLoadingConversation,
    loadOlderMessages,
    refreshActiveConversation,
    upsertRuns,
  }
}
