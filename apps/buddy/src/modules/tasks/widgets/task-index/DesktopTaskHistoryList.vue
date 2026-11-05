<script setup lang="ts">
import type { DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { TaskMarks } from '../../contracts'
import type { TaskHistoryRow } from './taskPinnedItems'
import type { useTaskIndexController } from './useTaskIndexController'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NVirtualList } from 'naive-ui'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopTaskRow from './DesktopTaskRow.vue'
import DesktopTaskSidebarSectionHeader from './DesktopTaskSidebarSectionHeader.vue'
import DesktopTaskSpaceRow from './DesktopTaskSpaceRow.vue'
import { getTaskHistoryRowScope } from './taskHistoryViewport'
import { getTaskHistoryScopeKey } from './taskPinnedItems'
import { DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP, DESKTOP_TASK_SIDEBAR_ROW_HEIGHT, DESKTOP_TASK_SIDEBAR_ROW_SIZE, DESKTOP_TASK_SIDEBAR_SECTION_HEADER_SIZE, DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES, resolveDesktopTaskSidebarSectionLayout } from './taskSidebarLayout'
import { useTaskHistoryViewport } from './useTaskHistoryViewport'

const props = defineProps<{
  section: DesktopTaskSidebarSection
  activeConversationId: string | null
  pendingConversationIds?: readonly string[]
  controller: ReturnType<typeof useTaskIndexController>
  language: BuddyLocale
  marks: TaskMarks
  moveToSpaceAvailable: (task: LocalConversationSummary) => boolean | undefined
}>()
const emit = defineEmits<{
  openTask: [id: string]
  manageMarks: []
  moveTask: [id: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const root = useTemplateRef<HTMLElement>('root')
const list = useTemplateRef<InstanceType<typeof NVirtualList>>('list')
const expanded = computed(() => props.controller.isSectionExpanded(props.section))
const rows = computed(() => {
  let section: DesktopTaskSidebarSection | undefined
  return props.controller.historyRows.value.filter((row): row is Exclude<TaskHistoryRow, { kind: 'section' }> => {
    if (row.kind === 'section') {
      section = row.section
      return false
    }
    return section === props.section
  })
})
const layout = computed(() => resolveDesktopTaskSidebarSectionLayout({
  expanded: expanded.value,
  priority: DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES[props.section],
  rowCount: rows.value.length,
}))
const labels = computed(() => ({
  pinned: t('desktop.tasks.pinnedSection'),
  spaces: t('desktop.tasks.spacesSection'),
  tasks: t('desktop.tasks.tasksSection'),
}))
const layoutStyle = computed(() => ({
  '--buddy-task-sidebar-section-natural-size': layout.value.naturalSize,
  '--buddy-task-sidebar-section-priority': layout.value.priority,
  '--buddy-task-sidebar-row-height': `${DESKTOP_TASK_SIDEBAR_ROW_HEIGHT}px`,
  '--buddy-task-sidebar-row-size': `${DESKTOP_TASK_SIDEBAR_ROW_SIZE}px`,
  '--buddy-task-sidebar-section-header-size': `${DESKTOP_TASK_SIDEBAR_SECTION_HEADER_SIZE}px`,
}))
const { ensureVisibleScopes, handleScroll, handleUserIntent, revealRow } = useTaskHistoryViewport({
  list,
  rows: () => rows.value,
  active: () => expanded.value,
  anchor: () => props.controller.historyAnchors.value[props.section],
  recordAnchor: anchor => props.controller.recordHistoryAnchor(props.section, anchor),
  ensureScope: spaceId => props.controller.ensureHistoryScope(spaceId),
  isSpaceExpanded: spaceId => props.controller.isSpaceExpanded(spaceId),
})
watch(() => props.controller.revealTarget.value, (target) => {
  if (target && rows.value.some(row => row.key === target.rowKey))
    void revealRow(target.rowKey)
})

function rowScope(row: TaskHistoryRow) {
  const spaceId = getTaskHistoryRowScope(row)
  return spaceId === undefined ? undefined : getTaskHistoryScopeKey(spaceId)
}

function moreLabel(row: Extract<TaskHistoryRow, { kind: 'more' }>) {
  if (row.loading)
    return t('common.loading')
  if (props.controller.failedHistoryScopes.value.has(getTaskHistoryScopeKey(row.spaceId)))
    return t('desktop.tasks.retryHistory')
  return t('desktop.tasks.showMoreHistory')
}

async function loadMore(row: Extract<TaskHistoryRow, { kind: 'more' }>, event: MouseEvent) {
  const focused = document.activeElement === event.currentTarget
  const previousKeys = new Set(rows.value.map(item => item.key))
  if (!await props.controller.loadMoreHistory(row.spaceId))
    return
  await nextTick()
  if (!focused)
    return
  const rowElements = () => root.value ? [root.value, ...root.value.querySelectorAll<HTMLElement>('[data-row-key]')] : []
  const existing = rowElements().find(element => element.dataset.rowKey === row.key)
  if (existing) {
    existing.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    return
  }
  const tasks = rows.value.filter(item => item.kind === 'task' && item.task.spaceId === row.spaceId)
  const target = tasks.find(item => !previousKeys.has(item.key)) ?? tasks.at(-1)
  const key = target?.key ?? (row.spaceId === null ? 'section:tasks' : `space:${row.spaceId}`)
  const targetElement = rowElements().find(element => element.dataset.rowKey === key)
  const viewport = list.value?.getScrollContainer()?.getBoundingClientRect()
  const bounds = targetElement?.getBoundingClientRect()
  if (!bounds || !viewport || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom)
    await revealRow(key)
  rowElements().find(element => element.dataset.rowKey === key)?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
}
</script>

<template>
  <section
    ref="root"
    class="desktop-task-history-list desktop-task-sidebar__section flex min-h-[var(--buddy-task-sidebar-section-header-size)] flex-col overflow-hidden"
    :class="[`is-${layout.mode}`, `desktop-task-sidebar__${section}`]"
    :data-row-key="`section:${section}`"
    data-row-kind="section"
    :style="layoutStyle"
    @pointerdown="handleUserIntent"
    @keydown="handleUserIntent"
  >
    <DesktopTaskSidebarSectionHeader
      :expanded="expanded"
      :label="labels[section]"
      :show-add="section === 'spaces'"
      @add="controller.openSpaceCreator"
      @toggle="controller.setSectionExpanded(section, !expanded)"
    />
    <NVirtualList
      v-show="expanded"
      ref="list"
      class="desktop-task-sidebar__virtual-list h-full min-h-0 flex-1"
      :padding-top="DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP"
      :items="rows"
      :item-size="DESKTOP_TASK_SIDEBAR_ROW_SIZE"
      key-field="key"
      :on-scroll="handleScroll"
      :on-resize="ensureVisibleScopes"
      :on-wheel="handleUserIntent"
    >
      <template #default="{ item }">
        <div
          :data-row-key="item.key"
          :data-row-kind="item.kind"
          :data-scope="rowScope(item)"
          class="h-[var(--buddy-task-sidebar-row-size)]"
        >
          <div v-if="item.kind === 'space'" class="h-full pr-[var(--buddy-task-sidebar-scrollbar-gutter)] pb-[calc(var(--buddy-task-sidebar-row-size)_-_var(--buddy-task-sidebar-row-height))] pl-[var(--buddy-task-sidebar-scrollbar-gutter)]">
            <DesktopTaskSpaceRow
              :dragging="controller.draggedPinnedItemKey.value === item.pinKey"
              :drop-position="item.pinnedTopLevel ? controller.getPinnedDropPosition(item.pinKey) : undefined"
              :expanded="controller.isSpaceExpanded(item.space.id)"
              :language="language"
              :pin-mode="item.pinnedTopLevel ? 'unpin' : 'pin'"
              :activity="controller.spaceActivities.value.get(item.space.id)"
              :space="item.space"
              :reorderable="item.pinnedTopLevel"
              :reorder-target="item.pinnedTopLevel"
              @drag-end="controller.endPinnedDrag"
              @drag-over="controller.enterPinnedDropTarget(item.pinKey!, $event)"
              @drag-start="controller.beginPinnedDrag(item.pinKey!)"
              @drop="controller.dropPinnedItem(item.pinKey!, $event)"
              @menu="controller.selectSpaceMenuAction(item.space, $event)"
              @pin="item.pinnedTopLevel ? controller.unpinItem(item.pinKey!) : controller.pinSpace(item.space.id)"
              @toggle="controller.toggleSpace(item.space.id)"
            />
          </div>
          <DesktopTaskRow
            v-else-if="item.kind === 'task'"
            :task-id="item.task.id"
            :active="item.task.id === activeConversationId"
            :activity="item.task.activity"
            :loading="pendingConversationIds?.includes(item.task.id)"
            :marks="marks.items.value"
            :mark-state="marks.states.value.get(item.task.id)"
            :marks-busy="marks.busy.value"
            :move-to-space-available="moveToSpaceAvailable(item.task)"
            :dragging="item.pinnedTopLevel && controller.draggedPinnedItemKey.value === item.pinKey"
            :drop-position="item.pinnedTopLevel ? controller.getPinnedDropPosition(item.pinKey) : undefined"
            :language="language"
            :now="controller.relativeTimeNow.value"
            :occurred-at="item.task.automationOccurrence?.scheduledFor ?? item.task.updatedAt"
            :pin-mode="item.pinnedTopLevel ? 'unpin' : item.spaceTask ? undefined : 'pin'"
            :space-task="item.spaceTask"
            :reorderable="item.pinnedTopLevel"
            :reorder-target="item.pinnedTopLevel"
            :title="controller.getTaskTitle(item.task)"
            @assign-mark="marks.assign(item.task.id, $event)"
            @clear-marks="marks.clear(item.task.id)"
            @set-read="marks.setRead(item.task.id, $event)"
            @manage-marks="emit('manageMarks')"
            @move-to-space="emit('moveTask', item.task.id)"
            @delete="controller.requestTaskDelete(item.task)"
            @drag-end="controller.endPinnedDrag"
            @drag-over="controller.enterPinnedDropTarget(item.pinKey!, $event)"
            @drag-start="controller.beginPinnedDrag(item.pinKey!)"
            @drop="controller.dropPinnedItem(item.pinKey!, $event)"
            @open="emit('openTask', item.task.id)"
            @pin="item.pinnedTopLevel ? controller.unpinItem(item.pinKey!) : controller.pinTask(item.task.id)"
            @rename="controller.requestTaskRename(item.task)"
          />
          <div v-else class="flex h-full items-center px-[var(--buddy-task-sidebar-scrollbar-gutter)] pb-[calc(var(--buddy-task-sidebar-row-size)_-_var(--buddy-task-sidebar-row-height))]" :class="{ 'pl-7': item.spaceId !== null }">
            <button
              class="desktop-task-history-list__more inline-flex h-6 flex-none items-center border-0 rounded-micro bg-transparent text-muted text-sidebar-item font-normal leading-[20px] text-left py-0 pr-2 pl-[13px] cursor-pointer hover:bg-hover hover:text-fg ui-focus-ring"
              type="button"
              :aria-busy="item.loading || undefined"
              :aria-disabled="item.loading || undefined"
              @click="!item.loading && loadMore(item, $event)"
            >
              {{ moreLabel(item) }}
            </button>
          </div>
        </div>
      </template>
    </NVirtualList>
  </section>
</template>

<style scoped lang="scss">
.desktop-task-history-list {
  --buddy-task-sidebar-action-gap: 0.125rem;
  --buddy-task-sidebar-action-inset: 0.4rem;
  --buddy-task-sidebar-action-size: 1.5rem;
  --buddy-task-sidebar-scrollbar-gutter: 0.5rem;
  --buddy-task-sidebar-state-radius: 6px;

  &.is-weighted {
    max-height: var(--buddy-task-sidebar-section-natural-size);
    flex: var(--buddy-task-sidebar-section-priority) 1 0;
  }

  &.is-collapsed {
    flex: 0 0 var(--buddy-task-sidebar-section-header-size);
  }

  :deep(.v-vl) {
    overflow-anchor: none;
    overscroll-behavior: contain;
  }
}
</style>
