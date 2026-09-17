import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { Ref } from 'vue'
import type { TaskIndex } from '../../contracts'
import type { TaskIndexManagementOptions } from './useTaskIndexManagement'
import type { DesktopTaskPinnedDropPosition } from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import {
  prependDesktopTaskPinnedItem,
  removeDesktopTaskPinnedItem,
  reorderDesktopTaskPinnedItems,
  resolveTaskIndexProjection,
} from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import { useTaskIndexManagement } from './useTaskIndexManagement'

interface UseTaskIndexControllerOptions extends TaskIndexManagementOptions {
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
  const projection = computed(() => resolveTaskIndexProjection({
    expandedSpaceIds: new Set(activeSpaces.value
      .filter(space => isSpaceExpanded(space.id))
      .map(space => space.id)),
    pinnedItems: options.pinnedItems.value,
    spaces: options.spaces.value,
    tasks: options.tasks.value,
  }))
  const pinnedItems = computed(() => projection.value.pinnedItems)
  const pinnedRows = computed(() => projection.value.pinnedRows)
  const spaceRows = computed(() => projection.value.spaceRows)
  const globalTasks = computed(() => projection.value.globalTasks)

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

  function toggleSpace(spaceId: string) {
    void options.sidebar().setSpaceExpanded(spaceId, !isSpaceExpanded(spaceId))
  }

  function isSectionExpanded(section: DesktopTaskSidebarSection) {
    return !options.sidebar().collapsedSections.value.has(section)
  }

  function setSectionExpanded(section: DesktopTaskSidebarSection, expanded: boolean) {
    void options.sidebar().setSectionExpanded(section, expanded)
  }

  function recordScrollAnchor(section: DesktopTaskSidebarSection, index: number) {
    options.sidebar().recordScrollAnchor(section, index)
  }

  const scrollAnchors = computed(() => options.sidebar().scrollAnchors.value)

  function pinSpace(spaceId: string) {
    options.onUpdatePinnedItems(prependDesktopTaskPinnedItem(
      pinnedItems.value,
      { id: spaceId, kind: 'space' },
    ))
  }

  function pinTask(conversationId: string) {
    options.onUpdatePinnedItems(prependDesktopTaskPinnedItem(
      pinnedItems.value,
      { id: conversationId, kind: 'conversation' },
    ))
  }

  function unpinItem(pinKey: string) {
    options.onUpdatePinnedItems(removeDesktopTaskPinnedItem(pinnedItems.value, pinKey))
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
      pinnedItems.value,
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
    recordScrollAnchor,
    scrollAnchors,
    setSectionExpanded,
    spaceRows,
    relativeTimeNow,
    toggleSpace,
    unpinItem,
  }
}
