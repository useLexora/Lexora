<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopTaskPinnedDropPosition } from '@/modules/tasks/widgets/task-index/taskPinnedItems'
import type { TaskSpaceMenuAction } from '@/modules/tasks/widgets/task-index/useTaskIndexManagement'
import {
  ChevronDown16Regular,
  ChevronRight16Regular,
  Delete20Regular,
  Edit20Regular,
  FolderOpen20Regular,
  MoreHorizontal20Regular,
} from '@vicons/fluent'
import { NDropdown } from 'naive-ui'
import { computed, h } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopOverflowingLabel from '@/modules/tasks/widgets/task-index/DesktopOverflowingLabel.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'
import DesktopSpaceIcon from '../space/DesktopSpaceIcon.vue'

const props = defineProps<{
  dragging?: boolean
  dropPosition?: DesktopTaskPinnedDropPosition
  expanded: boolean
  language: BuddyLocale
  pinMode: 'pin' | 'unpin'
  space: LocalSpace
  reorderable?: boolean
  reorderTarget?: boolean
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
    icon: () => h(DesktopIcon, { component: Edit20Regular, size: 14 }),
    key: 'edit',
    label: t('common.edit'),
  },
  {
    icon: () => h(DesktopIcon, { component: Delete20Regular, size: 14 }),
    key: 'delete',
    label: t('common.delete'),
  },
])
const menuThemeOverrides = {
  fontSizeSmall: '13px',
  optionIconPrefixWidthSmall: '28px',
  optionSuffixWidthSmall: '12px',
}
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

function handleDragStart(event: DragEvent) {
  if (!props.reorderable) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/plain', 'desktop-task-pinned-item')
  if (event.dataTransfer)
    event.dataTransfer.effectAllowed = 'move'
  emit('dragStart')
}

function handleDragOver(event: DragEvent) {
  if (!props.reorderTarget)
    return
  event.preventDefault()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
  emit('dragOver', resolveDropPosition(event))
}

function handleDrop(event: DragEvent) {
  if (!props.reorderTarget)
    return
  event.preventDefault()
  emit('drop', resolveDropPosition(event))
}

function resolveDropPosition(event: DragEvent): DesktopTaskPinnedDropPosition {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
}
</script>

<template>
  <div
    class="desktop-task-space-row"
    :class="{
      'is-dragging': dragging,
      'is-drop-after': dropPosition === 'after',
      'is-drop-before': dropPosition === 'before',
      'is-reorderable': reorderable,
    }"
    :draggable="reorderable"
    @dragend="emit('dragEnd')"
    @dragover="handleDragOver"
    @dragstart="handleDragStart"
    @drop="handleDrop"
  >
    <button
      class="desktop-task-space-row__name"
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
    <div class="desktop-task-space-row__actions">
      <NDropdown
        trigger="click"
        placement="bottom-start"
        size="small"
        :options="menuOptions"
        :theme-overrides="menuThemeOverrides"
        @select="handleMenuAction"
      >
        <button
          class="desktop-task-space-row__action"
          type="button"
          :aria-label="t('desktop.tasks.moreActions')"
        >
          <DesktopIcon :component="MoreHorizontal20Regular" />
        </button>
      </NDropdown>
      <button
        class="desktop-task-space-row__action desktop-task-space-row__pin"
        type="button"
        :aria-label="pinLabel"
        :aria-pressed="pinMode === 'unpin'"
        @click="emit('pin')"
      >
        <DesktopIcon :name="pinMode === 'pin' ? 'windowPin' : 'pinOff'" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-space-row {
  position: relative;
  display: flex;
  height: var(--buddy-task-sidebar-row-height);
  min-width: 0;
  align-items: center;
  border-radius: var(--buddy-task-sidebar-state-radius);
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    background: var(--buddy-nav-hover);
  }

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
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.25rem;
  color: var(--buddy-text-primary);
  font-size: var(--buddy-sidebar-space-font-size);
  font-weight: var(--buddy-sidebar-space-font-weight);
  line-height: 20px;
  padding: 0 0.375rem;
  text-align: left;

  .desktop-overflow-label {
    flex: 1;
  }

  &:focus-visible {
    border-radius: var(--buddy-task-sidebar-state-radius);
    outline: 1px solid var(--buddy-focus-ring);
    outline-offset: -1px;
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

.desktop-task-space-row__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--buddy-task-sidebar-action-gap);
  opacity: 0;
  padding-right: var(--buddy-task-sidebar-action-inset);
  pointer-events: none;
}

.desktop-task-space-row:hover .desktop-task-space-row__actions,
.desktop-task-space-row:has(:focus-visible) .desktop-task-space-row__actions {
  opacity: 1;
  pointer-events: auto;
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

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.desktop-task-space-row__pin {
  color: var(--buddy-text-muted);

  &[aria-pressed='true'] {
    color: var(--buddy-accent-solid);
  }
}
</style>
