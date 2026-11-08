import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { Ref } from 'vue'
import type { TaskIndex } from '../../contracts'
import type { TaskIndexManagementOptions } from './useTaskIndexManagement'
import type { DesktopTaskPinnedDropPosition } from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import { useIntervalFn } from '@vueuse/core'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import {
  getTaskHistoryScopeKey,
  prependDesktopTaskPinnedItem,
  removeDesktopTaskPinnedItem,
  reorderDesktopTaskPinnedItems,
  resolveSpaceActivities,
  resolveTaskHistoryRows,
  resolveTaskIndexProjection,
} from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import { useTaskIndexManagement } from './useTaskIndexManagement'

interface UseTaskIndexControllerOptions extends TaskIndexManagementOptions {
  activities: () => TaskIndex['activities']['value']
  activeConversationId: () => string | null
  history: () => TaskIndex['history']
  onHistoryError: () => void
  markStates: () => ReadonlyMap<string, LocalTaskMarkState>
  onUpdatePinnedItems: (items: DesktopTaskPinnedItem[]) => void
  pinnedItems: Readonly<Ref<ReadonlyArray<DesktopTaskPinnedItem>>>
  sidebar: () => TaskIndex['sidebar']
  spaces: Readonly<Ref<ReadonlyArray<LocalSpace>>>
  tasks: Readonly<Ref<ReadonlyArray<LocalConversationSummary>>>
}

interface DesktopTaskPinnedDropTarget {
  key: string
  position: DesktopTaskPinnedDropPosition
}

export function useTaskIndexController(options: UseTaskIndexControllerOptions) {
  const management = useTaskIndexManagement(options)
  const relativeTimeNow = shallowRef(Date.now())
  const draggedPinnedItemKey = shallowRef<string | null>(null)
  const pinnedDropTarget = shallowRef<DesktopTaskPinnedDropTarget | null>(null)
  const activeSpaces = computed(() => options.spaces.value.filter(
    space => space.revokedAt === null,
  ))
  const failedHistoryScopes = shallowRef<ReadonlySet<string>>(new Set())
  const historyRequests = new Map<string, Promise<boolean>>()
  const revealTarget = shallowRef<{ rowKey: string } | null>(null)
  let revealVersion = 0
  let disposed = false
  const expandedSpaceIds = computed(() => new Set(activeSpaces.value
    .filter(space => isSpaceExpanded(space.id))
    .map(space => space.id)))
  const projection = computed(() => resolveTaskIndexProjection({
    expandedSpaceIds: expandedSpaceIds.value,
    markedTaskIds: new Set([...options.markStates().values()]
      .filter(state => state.markId !== null)
      .map(state => state.conversationId)),
    unreadTaskIds: new Set([...options.markStates().values()]
      .filter(state => state.unread)
      .map(state => state.conversationId)),
    pinnedItems: options.pinnedItems.value,
    spaces: options.spaces.value,
    tasks: options.tasks.value,
  }))
  const pinnedItems = computed(() => projection.value.pinnedItems)
  const pinnedRows = computed(() => projection.value.pinnedRows)
  const spaceRows = computed(() => projection.value.spaceRows)
  const globalTasks = computed(() => projection.value.globalTasks)
  const taskActivities = computed(options.activities)
  const spaceActivities = computed(() => resolveSpaceActivities(options.tasks.value, taskActivities.value))
  const historyRows = computed(() => resolveTaskHistoryRows({
    projection: projection.value,
    collapsedSections: options.sidebar().collapsedSections.value,
    expandedSpaceIds: expandedSpaceIds.value,
    scopes: options.history().scopes.value,
  }))
  const historyAnchors = computed(() => options.history().anchors.value)

  watch(options.activeConversationId, (id) => {
    const version = ++revealVersion
    void options.history().setActiveTask(id).catch(() => {
      if (!disposed && version === revealVersion)
        options.onHistoryError()
    })
  }, { immediate: true })

  onScopeDispose(() => {
    disposed = true
    revealVersion += 1
  })

  useIntervalFn(() => {
    relativeTimeNow.value = Date.now()
  }, 60_000, {
    immediateCallback: true,
  })

  watch(
    activeSpaces,
    spaces => options.sidebar().pruneSpaces(new Set(spaces.map(space => space.id))),
    { immediate: true },
  )

  function isSpaceExpanded(spaceId: string) {
    return !options.sidebar().collapsedSpaceIds.value.has(spaceId)
  }

  async function toggleSpace(spaceId: string) {
    const expanded = !isSpaceExpanded(spaceId)
    if (await options.sidebar().setSpaceExpanded(spaceId, expanded) && expanded)
      await ensureHistoryScope(spaceId)
  }

  function isSectionExpanded(section: DesktopTaskSidebarSection) {
    return !options.sidebar().collapsedSections.value.has(section)
  }

  function setSectionExpanded(section: DesktopTaskSidebarSection, expanded: boolean) {
    void options.sidebar().setSectionExpanded(section, expanded)
  }

  function recordHistoryAnchor(section: DesktopTaskSidebarSection, anchor: TaskIndex['history']['anchors']['value'][DesktopTaskSidebarSection]) {
    options.history().recordAnchor(section, anchor)
  }

  async function requestHistory(spaceId: string | null, more: boolean): Promise<boolean> {
    const key = getTaskHistoryScopeKey(spaceId)
    const pending = historyRequests.get(key)
    if (pending)
      return pending
    const errors = new Set(failedHistoryScopes.value)
    errors.delete(key)
    failedHistoryScopes.value = errors
    const request = (async () => {
      try {
        if (more)
          await options.history().loadMore(spaceId)
        else
          await options.history().ensureScope(spaceId)
        return true
      }
      catch {
        if (!disposed) {
          failedHistoryScopes.value = new Set([...failedHistoryScopes.value, key])
          options.onHistoryError()
        }
        return false
      }
      finally {
        historyRequests.delete(key)
      }
    })()
    historyRequests.set(key, request)
    return request
  }

  async function ensureHistoryScope(spaceId: string | null): Promise<void> {
    const key = getTaskHistoryScopeKey(spaceId)
    const state = options.history().scopes.value.get(key)
    if (state?.initialized || state?.loading || failedHistoryScopes.value.has(key))
      return
    await requestHistory(spaceId, false)
  }

  function loadMoreHistory(spaceId: string | null): Promise<boolean> {
    const state = options.history().scopes.value.get(getTaskHistoryScopeKey(spaceId))
    return requestHistory(spaceId, state?.initialized ?? false)
  }

  async function revealTask(task: LocalConversationSummary): Promise<boolean> {
    const version = ++revealVersion
    try {
      await options.history().setActiveTask(task.id)
      if (disposed || version !== revealVersion)
        return false
      const spacePinned = options.pinnedItems.value.some(item => item.kind === 'space' && item.id === task.spaceId)
      const taskPinned = options.pinnedItems.value.some(item => item.kind === 'conversation' && item.id === task.id)
      const section = spacePinned || taskPinned ? 'pinned' : task.spaceId === null ? 'tasks' : 'spaces'
      const expanded = await options.sidebar().setSectionExpanded(section, true)
      if (!expanded || disposed || version !== revealVersion)
        return false
      if (task.spaceId !== null && !await options.sidebar().setSpaceExpanded(task.spaceId, true))
        return false
      if (disposed || version !== revealVersion)
        return false
      revealTarget.value = { rowKey: `conversation:${task.id}` }
      return true
    }
    catch {
      if (!disposed && version === revealVersion)
        options.onHistoryError()
      return false
    }
  }

  function pinSpace(spaceId: string) {
    options.onUpdatePinnedItems(prependDesktopTaskPinnedItem(
      options.pinnedItems.value,
      { id: spaceId, kind: 'space' },
    ))
  }

  function pinTask(conversationId: string) {
    options.onUpdatePinnedItems(prependDesktopTaskPinnedItem(
      options.pinnedItems.value,
      { id: conversationId, kind: 'conversation' },
    ))
  }

  function unpinItem(pinKey: string) {
    options.onUpdatePinnedItems(removeDesktopTaskPinnedItem(options.pinnedItems.value, pinKey))
  }

  function beginPinnedDrag(pinKey: string) {
    draggedPinnedItemKey.value = pinKey
    pinnedDropTarget.value = null
  }

  function enterPinnedDropTarget(pinKey: string, position: DesktopTaskPinnedDropPosition) {
    if (draggedPinnedItemKey.value && draggedPinnedItemKey.value !== pinKey)
      pinnedDropTarget.value = { key: pinKey, position }
  }

  function getPinnedDropPosition(pinKey: string | undefined) {
    return pinKey && pinnedDropTarget.value?.key === pinKey
      ? pinnedDropTarget.value.position
      : undefined
  }

  function dropPinnedItem(pinKey: string, position: DesktopTaskPinnedDropPosition) {
    if (!draggedPinnedItemKey.value)
      return
    options.onUpdatePinnedItems(reorderDesktopTaskPinnedItems(
      options.pinnedItems.value,
      draggedPinnedItemKey.value,
      pinKey,
      position,
    ))
    endPinnedDrag()
  }

  function endPinnedDrag() {
    draggedPinnedItemKey.value = null
    pinnedDropTarget.value = null
  }

  return {
    ...management,
    beginPinnedDrag,
    draggedPinnedItemKey,
    dropPinnedItem,
    endPinnedDrag,
    enterPinnedDropTarget,
    getPinnedDropPosition,
    globalTasks,
    isSectionExpanded,
    isSpaceExpanded,
    pinTask,
    pinSpace,
    pinnedItems,
    pinnedRows,
    ensureHistoryScope,
    failedHistoryScopes,
    historyAnchors,
    historyRows,
    loadMoreHistory,
    recordHistoryAnchor,
    revealTarget,
    revealTask,
    setSectionExpanded,
    spaceActivities,
    taskActivities,
    spaceRows,
    relativeTimeNow,
    toggleSpace,
    unpinItem,
  }
}
