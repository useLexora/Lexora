<script setup lang="ts">
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopTaskPinnedDropPosition } from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import type { TaskSpaceMenuAction } from '@/modules/tasks/widgets/task-index/useTaskIndexManagement'
import {
  ApprovalsApp20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  FolderOpen20Regular,
  MoreHorizontal20Regular,
} from '@vicons/fluent'
import { NDropdown } from 'naive-ui'
import { computed, h, shallowRef, useId, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopOverflowingLabel from '@/modules/tasks/widgets/task-index/DesktopOverflowingLabel.vue'
import BuddyChatActivitySpinner from '@/modules/tasks/widgets/transcript/BuddyChatActivitySpinner.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'
import DesktopSpaceIcon from '../space/DesktopSpaceIcon.vue'
import { useTaskHistoryDrag } from './useTaskHistoryDrag'

const props = defineProps<{
  dragging?: boolean
  dropPosition?: DesktopTaskPinnedDropPosition
  expanded: boolean
  language: BuddyLocale
  pinMode: 'pin' | 'unpin'
  space: LocalSpace
  reorderable?: boolean
  reorderTarget?: boolean
  activity?: LocalConversationSummary['activity']
}>()
const emit = defineEmits<{
  dragEnd: []
  dragOver: [position: DesktopTaskPinnedDropPosition]
  dragStart: []
  drop: [position: DesktopTaskPinnedDropPosition]
  menu: [action: TaskSpaceMenuAction]
  pin: []
  toggle: []
}>()
const { t } = useBuddyI18n(() => props.language)
const router = useRouter()
const menuOptions = computed<DropdownOption[]>(() => [
  {
    icon: () => h(DesktopIcon, { name: 'navigationTask', size: 14 }),
    key: 'new-task',
    label: t('desktop.tasks.newTask'),
  },
  {
    icon: () => h(DesktopIcon, { component: FolderOpen20Regular, size: 14 }),
    key: 'open-directory',
    label: t('desktop.tasks.openSpaceWorkingDirectory'),
    show: Boolean(props.space.primaryDirectory),
  },
  { key: 'task-management-divider', type: 'divider' },
  {
    icon: () => h(DesktopIcon, { component: SkillIcon, size: 14 }),
    key: 'skills',
    label: t('desktop.skills.manage'),
  },
  {
    icon: () => h(DesktopIcon, { name: 'edit', size: 14 }),
    key: 'edit',
    label: t('common.edit'),
  },
  {
    icon: () => h(DesktopIcon, { name: 'delete', size: 14 }),
    key: 'delete',
    label: t('common.delete'),
  },
])
const menuThemeOverrides = {
  fontSizeSmall: '13px',
  optionIconPrefixWidthSmall: '28px',
  optionSuffixWidthSmall: '12px',
}
const showActivity = computed(() => !props.expanded
  && (props.activity === 'running' || props.activity === 'awaiting_approval'))
const activityLabel = computed(() => props.activity === 'awaiting_approval'
  ? t('activity.approval')
  : t('run.status.running'))
const pinLabel = computed(() => props.pinMode === 'pin'
  ? t('desktop.tasks.pin')
  : t('desktop.tasks.unpin'))

function handleMenuAction(action: string | number): void {
  if (action === 'skills') {
    void router.push(desktopRouteLocations.skills(props.space.id))
    return
  }
  if (action === 'new-task' || action === 'open-directory' || action === 'edit' || action === 'delete')
    emit('menu', action)
}

// 右键空间行弹出与“更多”相同的菜单；位置单独保存，关闭时才会在原位消失。
const contextMenuOpen = shallowRef(false)
const contextMenuPosition = shallowRef({ x: 0, y: 0 })
function openContextMenu(event: MouseEvent): void {
  contextMenuPosition.value = { x: event.clientX, y: event.clientY }
  contextMenuOpen.value = true
}
function handleContextMenuAction(action: string | number): void {
  contextMenuOpen.value = false
  handleMenuAction(action)
}

const dragId = useId()
const element = useTemplateRef<HTMLElement>('row')
const handle = useTemplateRef<HTMLElement>('handle')
useTaskHistoryDrag({
  id: () => dragId,
  element: computed(() => props.reorderable ? element.value : null),
  handle: computed(() => props.reorderable ? handle.value : null),
  type: 'pinned-space',
  data: () => ({ title: props.space.name }),
  disabled: () => !props.reorderable,
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
    class="desktop-task-space-row relative flex h-[var(--buddy-task-sidebar-row-height)] min-w-0 items-center rounded-[var(--buddy-task-sidebar-state-radius)] hover:bg-nav-hover"
    :class="{
      'is-dragging': dragging,
      'is-drop-after': dropPosition === 'after',
      'is-drop-before': dropPosition === 'before',
      'is-reorderable': reorderable,
    }"
    @contextmenu.prevent="openContextMenu"
  >
    <NDropdown
      trigger="manual"
      placement="bottom-start"
      size="small"
      :show="contextMenuOpen"
      :x="contextMenuPosition.x"
      :y="contextMenuPosition.y"
      :options="menuOptions"
      :theme-overrides="menuThemeOverrides"
      @clickoutside="contextMenuOpen = false"
      @select="handleContextMenuAction"
    />
    <button
      ref="handle"
      class="desktop-task-space-row__name flex min-w-0 flex-1 items-center gap-1 text-fg text-[length:var(--buddy-sidebar-space-font-size)] [font-weight:var(--buddy-sidebar-space-font-weight)] leading-[20px] py-0 px-[0.375rem] text-left focus-visible:rounded-[var(--buddy-task-sidebar-state-radius)] focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-focus focus-visible:outline-offset-[-1px]"
      type="button"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <DesktopIcon
        class="desktop-task-space-row__chevron"
        :component="expanded ? ChevronDown16Regular : ChevronRight16Regular"
      />
      <DesktopSpaceIcon
        class="desktop-task-space-row__folder"
        :icon="space.icon"
        :icon-color="space.iconColor"
      />
      <DesktopOverflowingLabel :paused="dragging" :text="space.name" />
    </button>
    <div class="desktop-task-space-row__actions flex flex-none items-center gap-[var(--buddy-task-sidebar-action-gap)] opacity-0 pr-[var(--buddy-task-sidebar-action-inset)] pointer-events-none">
      <NDropdown
        trigger="click"
        placement="bottom-start"
        size="small"
        :options="menuOptions"
        :theme-overrides="menuThemeOverrides"
        @select="handleMenuAction"
      >
        <button
          class="desktop-task-space-row__action ui-focus-ring"
          type="button"
          :aria-label="t('desktop.tasks.moreActions')"
        >
          <DesktopIcon :component="MoreHorizontal20Regular" />
        </button>
      </NDropdown>
      <button
        class="desktop-task-space-row__action desktop-task-space-row__pin ui-focus-ring"
        type="button"
        :aria-label="pinLabel"
        :aria-pressed="pinMode === 'unpin'"
        @click="emit('pin')"
      >
        <DesktopIcon :name="pinMode === 'pin' ? 'windowPin' : 'pinOff'" :size="16" />
      </button>
    </div>
    <span
      v-if="showActivity"
      class="desktop-task-space-row__activity absolute top-[50%] right-[var(--buddy-task-sidebar-action-inset)] grid w-[var(--buddy-task-sidebar-action-size)] h-[var(--buddy-task-sidebar-action-size)] place-items-center text-muted pointer-events-none"
      :class="{
        'is-awaiting-approval': activity === 'awaiting_approval',
        'is-running': activity === 'running',
      }"
      role="status"
      :aria-label="activityLabel"
    >
      <BuddyChatActivitySpinner v-if="activity === 'running'" />
      <DesktopIcon v-else :component="ApprovalsApp20Regular" :size="16" />
    </span>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-space-row {
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &.is-reorderable {
    cursor: grab;
  }

  &.is-dragging {
    opacity: 0.48;
  }

  &.is-drop-before::before,
  &.is-drop-after::after {
    position: absolute;
    z-index: 1;
    right: 0;
    left: 0;
    height: 2px;
    background: var(--buddy-accent-solid);
    content: '';
    pointer-events: none;
  }

  &.is-drop-before::before {
    top: 0;
  }

  &.is-drop-after::after {
    bottom: 0;
  }
}

button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.desktop-task-space-row__name {
  .desktop-overflow-label {
    flex: 1;
  }
}

.desktop-task-space-row__chevron,
.desktop-task-space-row__folder {
  flex: none;
}

.desktop-task-space-row__chevron {
  font-size: 14px;
}

.desktop-task-space-row__folder {
  font-size: 16px;
  margin-right: 0.0625rem;
}

.desktop-task-space-row:hover .desktop-task-space-row__actions,
.desktop-task-space-row:has(:focus-visible) .desktop-task-space-row__actions {
  opacity: 1;
  pointer-events: auto;
}

.desktop-task-space-row__activity {
  transform: translateY(-50%);

  &.is-awaiting-approval {
    color: var(--buddy-status-warning-text);
  }
}

.desktop-task-space-row:hover .desktop-task-space-row__activity,
.desktop-task-space-row:has(:focus-visible) .desktop-task-space-row__activity {
  opacity: 0;
}

.desktop-task-space-row__action {
  display: grid;
  width: var(--buddy-task-sidebar-action-size);
  height: var(--buddy-task-sidebar-action-size);
  flex: none;
  place-items: center;
  padding: 0;
  border-radius: var(--buddy-icon-button-radius);
  color: var(--buddy-text-secondary);
  line-height: 1;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  .n-icon {
    display: flex;
    font-size: 16px;
  }

  &:hover {
    background: var(--buddy-nav-hover);
    color: var(--buddy-text-strong);
  }
}

.desktop-task-space-row__pin {
  color: var(--buddy-text-muted);

  &[aria-pressed='true'] {
    color: var(--buddy-accent-solid);
  }
}
</style>
