<script setup lang="ts">
import type { LocalTaskMark, LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { DropdownOption } from 'naive-ui'
import type { TaskActivity } from '../../contracts'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopTaskPinnedDropPosition } from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import {
  Archive20Regular,
  MoreHorizontal20Regular,
} from '@vicons/fluent'
import { NDropdown, NTooltip } from 'naive-ui'
import { computed, h, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopOverflowingLabel from '@/modules/tasks/widgets/task-index/DesktopOverflowingLabel.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopTaskActivity from './DesktopTaskActivity.vue'
import DesktopTaskMarkSwatch from './DesktopTaskMarkSwatch.vue'
import { formatTaskRelativeTime } from './taskRelativeTime'
import { useTaskHistoryDrag } from './useTaskHistoryDrag'
import { useTaskMenuActions } from './useTaskMenuActions'

const props = withDefaults(defineProps<{
  taskId: string
  active: boolean
  loading?: boolean
  marks: readonly LocalTaskMark[]
  markState?: LocalTaskMarkState
  marksBusy: boolean
  activity: TaskActivity
  moveToSpaceAvailable?: boolean
  dragging?: boolean
  dropPosition?: DesktopTaskPinnedDropPosition
  language: BuddyLocale
  now: number
  occurredAt: string
  pinMode?: 'pin' | 'unpin'
  spaceTask?: boolean
  reorderable?: boolean
  reorderTarget?: boolean
  title: string
}>(), {
  moveToSpaceAvailable: undefined,
})

const emit = defineEmits<{
  delete: []
  archive: []
  assignMark: [markId: string]
  clearMarks: []
  setRead: [read: boolean]
  manageMarks: []
  moveToSpace: []
  dragEnd: []
  dragOver: [position: DesktopTaskPinnedDropPosition]
  dragStart: []
  drop: [position: DesktopTaskPinnedDropPosition]
  open: []
  pin: []
  rename: []
}>()

const { t } = useBuddyI18n(() => props.language)
const opening = shallowRef(false)
watch(() => props.loading, (loading, _, cleanup) => {
  opening.value = false
  if (loading) {
    const timer = setTimeout(() => opening.value = true, 200)
    cleanup(() => clearTimeout(timer))
  }
}, { immediate: true })
const relativeTimeLabel = computed(() => (
  formatTaskRelativeTime(props.occurredAt, props.now, props.language)
))
const pinLabel = computed(() => props.pinMode === 'pin'
  ? t('desktop.tasks.pin')
  : t('desktop.tasks.unpin'))
const marker = computed(() => props.marks.find(mark => mark.id === props.markState?.markId)
  ?? (props.markState?.unread ? { name: t('desktop.marks.unread'), description: t('desktop.marks.unreadDescription'), color: 'var(--buddy-accent-solid)' } : null))
const { actions: taskActions, select: selectTaskAction } = useTaskMenuActions({
  task: () => props,
  language: () => props.language,
  assignMark: (_, markId) => emit('assignMark', markId),
  clearMarks: () => emit('clearMarks'),
  setRead: (_, read) => emit('setRead', read),
  manageMarks: () => emit('manageMarks'),
  moveToSpaceAvailable: () => props.moveToSpaceAvailable,
  moveToSpace: () => emit('moveToSpace'),
})
const actions = computed<DropdownOption[]>(() => [
  ...taskActions.value,
  { icon: () => h(DesktopIcon, { name: 'edit' }), key: 'rename', label: t('desktop.tasks.renameTask') },
  { icon: () => h(DesktopIcon, { component: Archive20Regular }), key: 'archive', label: t('desktop.archive.archive') },
  { type: 'divider', key: 'delete-divider' },
  { icon: () => h(DesktopIcon, { name: 'delete', class: 'text-danger' }), key: 'delete', label: () => h('span', { class: 'text-danger' }, t('desktop.tasks.deleteTask')) },
])

function handleAction(action: string | number) {
  selectTaskAction(action)
  if (action === 'rename')
    emit('rename')
  if (action === 'delete')
    emit('delete')
  if (action === 'archive')
    emit('archive')
}

// 右键行弹出与“更多”相同的菜单，位置跟随鼠标。
// 位置单独保存：关闭时保留最后的坐标，菜单才会在原位消失，而不是飞到左上角。
const contextMenuOpen = shallowRef(false)
const contextMenuPosition = shallowRef({ x: 0, y: 0 })
function openContextMenu(event: MouseEvent) {
  contextMenuPosition.value = { x: event.clientX, y: event.clientY }
  contextMenuOpen.value = true
}
function closeContextMenu() {
  contextMenuOpen.value = false
}
function handleContextAction(action: string | number) {
  handleAction(action)
  closeContextMenu()
}

const dragId = useId()
const element = useTemplateRef<HTMLElement>('row')
const handle = useTemplateRef<HTMLElement>('handle')
useTaskHistoryDrag({
  id: () => dragId,
  element,
  handle,
  type: 'workbench-task',
  data: () => ({
    title: props.title,
    resource: { scheme: 'task', id: props.taskId, data: {} },
  }),
  disabled: () => false,
  reorderable: () => !!props.reorderable,
  reorderTarget: () => !!props.reorderTarget,
  start: () => emit('dragStart'),
  end: () => emit('dragEnd'),
  over: position => emit('dragOver', position),
  drop: position => emit('drop', position),
})
</script>

<template>
  <div
    ref="row"
    class="desktop-task-row relative h-[var(--buddy-task-sidebar-row-size,_2.5rem)] min-w-0 pr-[var(--buddy-task-sidebar-scrollbar-gutter,_0)] pb-[calc(var(--buddy-task-sidebar-row-size,_2.5rem)_-_var(--buddy-task-sidebar-row-height,_2.25rem))]"
    :data-task-id="taskId"
    :class="{
      'is-active': active,
      'is-dragging opacity-48': dragging,
      'is-drop-after': dropPosition === 'after',
      'is-drop-before': dropPosition === 'before',
      'is-space-task pl-7': spaceTask,
      'pl-[var(--buddy-task-sidebar-scrollbar-gutter,_0)]': !spaceTask,
      'is-reorderable cursor-grab': reorderable,
    }"
    @contextmenu.prevent="openContextMenu"
  >
    <NDropdown
      class="buddy-spaced-submenus"
      trigger="manual"
      placement="bottom-start"
      :show="contextMenuOpen"
      :x="contextMenuPosition.x"
      :y="contextMenuPosition.y"
      :options="actions"
      @clickoutside="closeContextMenu"
      @select="handleContextAction"
    />
    <div
      class="desktop-task-row__surface relative flex h-full min-w-0 items-center pl-[6px] rounded-[var(--buddy-task-sidebar-state-radius,_8px)] transition-state-colors"
      :class="[active ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'text-fg hover:bg-hover focus-within:bg-hover active:bg-pressed', { 'is-space': spaceTask }]"
    >
      <span class="grid w-[3px] flex-none place-items-center leading-[0]" :data-mark-id="markState?.markId ?? (markState?.unread ? 'system:unread' : undefined)">
        <NTooltip v-if="marker" placement="right">
          <template #trigger>
            <span role="img" :aria-label="marker.name"><DesktopTaskMarkSwatch :color="marker.color" compact /></span>
          </template>
          <div class="max-w-[260px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            <strong>{{ marker.name }}</strong>
            <p v-if="marker.description" class="m-0 mt-[4px] text-[12px]">{{ marker.description }}</p>
          </div>
        </NTooltip>
        <DesktopTaskMarkSwatch v-else compact />
      </span>
      <button
        ref="handle"
        class="desktop-task-sidebar__task flex min-w-0 flex-1 items-center text-[length:var(--buddy-task-sidebar-item-font-size,_var(--buddy-sidebar-item-font-size))] [font-weight:var(--buddy-sidebar-item-font-weight)] leading-[20px] pt-0 pr-2 pb-0 pl-[4px] text-left text-inherit ui-focus-ring focus-visible:rounded-micro border-0 bg-transparent cursor-pointer"
        :class="{ 'is-active': active }"
        type="button"
        :aria-busy="loading || undefined"
        @click="emit('open')"
      >
        <span v-if="opening" class="desktop-task-row__opening flex flex-none items-center mr-[6px]" aria-hidden="true"><BuddyChatActivitySpinner /></span>
        <DesktopOverflowingLabel class="flex-1" :paused="dragging" :text="title" />
      </button>
      <div class="grid w-[calc(2_*_var(--buddy-task-sidebar-action-size,_1.75rem)_+_var(--buddy-task-sidebar-action-gap,_0.125rem)_+_var(--buddy-task-sidebar-action-inset,_0.25rem))] flex-none items-center pr-[var(--buddy-task-sidebar-action-inset,_0.25rem)]">
        <time
          v-if="activity === 'idle'"
          class="desktop-task-row__relative-time max-w-full overflow-hidden text-[0.75rem] leading-[1] pointer-events-none text-ellipsis whitespace-nowrap [grid-area:1/1] justify-self-end"
          :class="active ? 'text-inherit' : 'text-muted'"
          :datetime="occurredAt"
        >{{ relativeTimeLabel }}</time>
        <DesktopTaskActivity
          v-else
          class="desktop-task-row__activity grid w-[var(--buddy-task-sidebar-action-size,_1.75rem)] h-[var(--buddy-task-sidebar-action-size,_1.75rem)] place-items-center [grid-area:1/1] justify-self-end"
          :class="activity === 'running' ? active ? 'text-inherit' : 'text-muted' : ''"
          :activity="activity"
          :language="language"
        />
        <div class="desktop-task-row__actions flex items-center gap-[var(--buddy-task-sidebar-action-gap,_0.125rem)] opacity-0 pointer-events-none [grid-area:1/1] justify-self-end">
          <NDropdown class="buddy-spaced-submenus" trigger="click" placement="bottom-start" :options="actions" @select="handleAction">
            <button
              class="desktop-task-sidebar__more ui-focus-ring transition-state-colors grid w-[var(--buddy-task-sidebar-action-size,1.75rem)] h-[var(--buddy-task-sidebar-action-size,1.75rem)] flex-none place-items-center p-0 border-0 rounded-icon bg-transparent cursor-pointer leading-[1]"
              :class="active ? 'text-inherit hover:bg-nav-selected-hover' : 'text-muted hover:(bg-nav-hover text-strong)'"
              type="button"
              :aria-label="t('desktop.tasks.moreActions')"
            >
              <DesktopIcon class="flex" :size="16" :component="MoreHorizontal20Regular" />
            </button>
          </NDropdown>
          <button
            v-if="pinMode"
            class="desktop-task-sidebar__more desktop-task-sidebar__pin ui-focus-ring transition-state-colors grid w-[var(--buddy-task-sidebar-action-size,1.75rem)] h-[var(--buddy-task-sidebar-action-size,1.75rem)] flex-none place-items-center p-0 border-0 rounded-icon bg-transparent cursor-pointer leading-[1]"
            type="button"
            :aria-label="pinLabel"
            :aria-pressed="pinMode === 'unpin'"
            :class="active ? 'text-inherit hover:bg-nav-selected-hover' : pinMode === 'unpin' ? 'text-accent hover:(bg-nav-hover text-accent)' : 'text-muted hover:(bg-nav-hover text-strong)'"
            @click="emit('pin')"
          >
            <DesktopIcon class="flex" :name="pinMode === 'pin' ? 'windowPin' : 'pinOff'" :size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-row {
  &.is-drop-before::before,
  &.is-drop-after::after {
    position: absolute;
    z-index: 1;
    right: var(--buddy-task-sidebar-scrollbar-gutter, 0);
    left: var(--buddy-task-sidebar-scrollbar-gutter, 0);
    height: 2px;
    background: var(--buddy-accent-solid);
    content: '';
    pointer-events: none;
  }

  &.is-drop-before::before { top: 0; }
  &.is-drop-after::after { bottom: 0; }

  &:hover,
  &:has(:focus-visible) {
    .desktop-task-row__relative-time,
    .desktop-task-row__activity {
      opacity: 0;
    }

    .desktop-task-row__actions {
      opacity: 1;
      pointer-events: auto;
    }
  }
}
</style>
