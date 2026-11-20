import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunSync, ChatRunSyncOptions } from './typing'
import { readRunEventWindow } from '@buddy-shared/runs/readRunEventWindow'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { mergeConversationTimelinePages, timelineItemKey } from '../../model/runs/chatTimelineMerge'
import { useChatRunProjection } from './useChatRunProjection'

const TIMELINE_PAGE_SIZE = 100
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
  snapshot: PromiseWithResolvers<void>
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
  let loadedBranchId: string | null = null
  let loadedConversationId: string | null = null
  let generation = 0
  let disposed = false
  let refreshFlight: RefreshFlight | null = null
  let refreshTimer: number | null = null
  const changedWindows = new Map<string, string>()
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

  async function refreshActiveConversation({ waitForEvents = true } = {}): Promise<void> {
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
      snapshot: Promise.withResolvers<void>(),
      promise: Promise.resolve(),
      request: { branchId, conversationId, generation },
    }
    flight.promise = drainRefreshFlight(flight).finally(() => {
      if (refreshFlight === flight)
        refreshFlight = null
    })
    refreshFlight = flight
    return waitForEvents ? flight.promise : flight.snapshot.promise
  }

  async function drainRefreshFlight(flight: RefreshFlight): Promise<void> {
    do {
      flight.dirty = false
      await refreshSnapshot(flight)
    } while (flight.dirty && isCurrent(flight.request))
  }

  async function loadEventWindows(page: LocalConversationTimelinePage, request: ProjectionRequest) {
    const read = options.api.conversations.readEventPage
    if (!page.eventWindows)
      return
    const windows = new Map(page.eventWindows.map(window => [window.runId, window]))
    for (const run of page.runs) {
      if (!isCurrent(request))
        return
      const window = windows.get(run.id) ?? { runId: run.id, count: 0, throughSequence: 0 }
      const prior = projection.loadedWindows.get(run.id)
      if (run.errorCode === 'EVENT_LOG_CORRUPTED') {
        projection.commitWindow(window, [], 'quarantined')
        continue
      }
      if (prior?.throughSequence === window.throughSequence && prior.count === window.count)
        continue
      if (prior && prior.throughSequence > window.throughSequence)
        continue
      const append = prior && window.count - prior.count === window.throughSequence - prior.throughSequence
      const afterSequence = append ? prior.throughSequence : 0
      const events = await readRunEventWindow(read, { conversationId: request.conversationId, runId: run.id, throughSequence: window.throughSequence, afterSequence }, () => isCurrent(request))
      if (!isCurrent(request))
        return
      if (projection.loadedWindows.get(run.id) !== prior)
        continue
      if (events.length !== window.count - (append ? prior.count : 0)) {
        const version = `${window.count}:${window.throughSequence}`
        if (changedWindows.get(run.id) === version)
          throw Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' })
        changedWindows.set(run.id, version)
        scheduleRefresh()
        continue
      }
      changedWindows.delete(run.id)
      projection.commitWindow(window, events, append ? 'append' : 'replace')
    }
  }

  async function refreshSnapshot(flight: RefreshFlight): Promise<void> {
    const { request } = flight
    try {
      const [latest, approvals] = await Promise.all([
        options.api.conversations.listTimeline({
          eventView: 'paged',
          branchId: request.branchId,
          conversationId: request.conversationId,
          limit: TIMELINE_PAGE_SIZE,
        }),
        options.api.approvals.list({ conversationId: request.conversationId, branchId: request.branchId, limit: 100, status: 'pending' }),
      ])
      if (!isCurrent(request))
        return
      let page = latest
      const rememberedStart = projection.getRefreshBoundaryKey()
      while (page.nextCursor) {
        if (!rememberedStart || page.items.some(item => timelineItemKey(item) === rememberedStart))
          break
        const older = await options.api.conversations.listTimeline({
          eventView: 'paged',
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
        settledScopeKey.value = `${request.conversationId}:${request.branchId}`
        flight.snapshot.resolve()
        await loadEventWindows(page, request)
      }
    }
    catch (error) {
      if (isCurrent(request))
        options.onError(error)
    }
    finally {
      flight.snapshot.resolve()
      if (isCurrent(request))
        settledScopeKey.value = `${request.conversationId}:${request.branchId}`
    }
  }

  async function loadOlderMessages(): Promise<boolean> {
    const request = currentRequest()
    const cursor = projection.timelineCursor.value
    if (!request || !cursor || isLoadingOlderMessages.value)
      return false
    isLoadingOlderMessages.value = true
    try {
      const page = await options.api.conversations.listTimeline({
        eventView: 'paged',
        branchId: request.branchId,
        conversationId: request.conversationId,
        cursor,
        limit: TIMELINE_PAGE_SIZE,
      })
      if (!isCurrent(request) || projection.timelineCursor.value !== cursor)
        return false
      await loadEventWindows(page, request)
      return isCurrent(request) && projection.timelineCursor.value === cursor && projection.prependPage(page)
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
    if (!request)
      return
    if (!projection.hasRun(event.runId)) {
      if (SNAPSHOT_RECONCILIATION_EVENT_TYPES.has(event.type))
        scheduleRefresh()
      return
    }
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
    if (turn.userMessage)
      projection.upsertMessage(turn.userMessage)
    settledScopeKey.value = `${turn.conversationId}:${turn.branchId}`
    scheduleRefresh()
  }

  function applyReplacementTurn(turn: LocalTurnStart, messageId: string, retainMessage: boolean) {
    if (!isActive(turn.conversationId, turn.branchId))
      return
    invalidatePendingWork()
    projection.replaceTurn(turn.run, messageId, retainMessage)
    if (turn.userMessage)
      projection.upsertMessage(turn.userMessage)
    loadedConversationId = turn.conversationId
    loadedBranchId = turn.branchId
    settledScopeKey.value = `${turn.conversationId}:${turn.branchId}`
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
    changedWindows.clear()
    refreshFlight?.snapshot.resolve()
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
