<script setup lang="ts">
import type { DesktopTaskPinnedItem } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'

import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { TaskIndex, TaskMarks } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskSpaceInput } from '@/modules/tasks/state/task-index/typing'
import { Add20Regular, Tag20Regular } from '@vicons/fluent'
import { NAlert, NButton, NInput, NModal, NTooltip } from 'naive-ui'
import { shallowRef, toRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceDialog from '@/modules/tasks/widgets/task-index/DesktopSpaceDialog.vue'
import DesktopTaskRow from '@/modules/tasks/widgets/task-index/DesktopTaskRow.vue'
import DesktopTaskSearchDialog from '@/modules/tasks/widgets/task-index/DesktopTaskSearchDialog.vue'
import DesktopTaskSidebarSection from '@/modules/tasks/widgets/task-index/DesktopTaskSidebarSection.vue'
import DesktopTaskSpaceRow from '@/modules/tasks/widgets/task-index/DesktopTaskSpaceRow.vue'
import {
  DESKTOP_TASK_SIDEBAR_ROW_HEIGHT,
  DESKTOP_TASK_SIDEBAR_ROW_SIZE,
  DESKTOP_TASK_SIDEBAR_SECTION_HEADER_SIZE,
  DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES,
} from '@/modules/tasks/widgets/task-index/taskSidebarLayout'
import { useTaskIndexController } from '@/modules/tasks/widgets/task-index/useTaskIndexController'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopWorkspaceSidebarIdentity from '@/shared/ui/workspace-sidebar/DesktopWorkspaceSidebarIdentity.vue'
import DesktopTaskMarkManager from './DesktopTaskMarkManager.vue'

const props = defineProps<{
  activeConversationId: string | null
  pendingConversationIds?: readonly string[]
  marks: TaskMarks
  appSidebarCollapsed: boolean
  language: BuddyLocale
  pinnedItems: ReadonlyArray<DesktopTaskPinnedItem>
  sidebar: TaskIndex['sidebar']
  spaces: ReadonlyArray<LocalSpace>
  selectSpaceDirectory: () => Promise<string | null>
  createSpace: (input: TaskSpaceInput) => Promise<boolean>
  updateSpace: (input: TaskSpaceInput & { spaceId: string }) => Promise<boolean>
  tasks: ReadonlyArray<LocalConversationSummary>
}>()
const emit = defineEmits<{
  deleteSpace: [spaceId: string]
  deleteTask: [conversationId: string]
  newTask: [spaceId: string | null]
  openSpaceDirectory: [spaceId: string]
  openTask: [conversationId: string]
  renameTask: [conversationId: string, title: string]
  updatePinnedItems: [items: DesktopTaskPinnedItem[]]
}>()

const { t } = useBuddyI18n(() => props.language)
const marksOpen = shallowRef(false)
const searchOpen = shallowRef(false)
function markBindings(conversationId: string) {
  return {
    loading: props.pendingConversationIds?.includes(conversationId),
    marks: props.marks.items.value,
    markState: props.marks.states.value.get(conversationId),
    marksBusy: props.marks.busy.value,
    onAssignMark: (markId: string) => props.marks.assign(conversationId, markId),
    onClearMarks: () => props.marks.clear(conversationId),
    onSetRead: (read: boolean) => props.marks.setRead(conversationId, read),
    onManageMarks: () => marksOpen.value = true,
  }
}
const sidebarLayoutStyle = {
  '--buddy-task-sidebar-row-height': `${DESKTOP_TASK_SIDEBAR_ROW_HEIGHT}px`,
  '--buddy-task-sidebar-row-size': `${DESKTOP_TASK_SIDEBAR_ROW_SIZE}px`,
  '--buddy-task-sidebar-section-header-size': `${DESKTOP_TASK_SIDEBAR_SECTION_HEADER_SIZE}px`,
}
const {
  beginPinnedDrag,
  confirmTaskDelete,
  confirmTaskRename,
  confirmSpaceDelete,
  draggedPinnedItemKey,
  dropPinnedItem,
  endPinnedDrag,
  enterPinnedDropTarget,
  getTaskTitle,
  getPinnedDropPosition,
  isSectionExpanded,
  isSpaceExpanded,
  openSpaceCreator,
  pinTask,
  pinSpace,
  pinnedItems: visiblePinnedItems,
  pinnedRows,
  recordScrollAnchor,
  scrollAnchors,
  setSectionExpanded,
  spaceDeleteTarget,
  spaceDialogOpen,
  spaceEditTarget,
  spaceRows,
  relativeTimeNow,
  requestTaskDelete,
  requestTaskRename,
  saveSpace,
  selectSpaceMenuAction,
  globalTasks,
  taskDeleteTarget,
  taskRenameTarget,
  taskTitleDraft,
  toggleSpace,
  unpinItem,
} = useTaskIndexController({
  getUntitledLabel: () => t('desktop.tasks.untitled'),
  onCreateSpace: input => props.createSpace(input),
  onDeleteTask: conversationId => emit('deleteTask', conversationId),
  onDeleteSpace: spaceId => emit('deleteSpace', spaceId),
  onNewTask: spaceId => emit('newTask', spaceId),
  onOpenSpaceDirectory: spaceId => emit('openSpaceDirectory', spaceId),
  onRenameTask: (conversationId, title) => emit('renameTask', conversationId, title),
  onUpdatePinnedItems: items => emit('updatePinnedItems', items),
  onUpdateSpace: input => props.updateSpace(input),
  pinnedItems: toRef(props, 'pinnedItems'),
  sidebar: () => props.sidebar,
  spaces: toRef(props, 'spaces'),
  tasks: toRef(props, 'tasks'),
})

function openSearchTask(conversationId: string) {
  searchOpen.value = false
  emit('openTask', conversationId)
}

function openSearchSpace(spaceId: string) {
  searchOpen.value = false
  emit('newTask', spaceId)
}
</script>

<template>
  <aside class="desktop-task-sidebar">
    <header class="desktop-task-sidebar__header">
      <DesktopWorkspaceSidebarIdentity
        :label="t('desktop.navigation.tasks')"
        :visible="appSidebarCollapsed"
      />
      <NTooltip>
        <template #trigger>
          <button class="desktop-task-sidebar__search-trigger" type="button" :aria-label="t('desktop.search.title')" @click="searchOpen = true">
            <DesktopIcon name="toolSearch" :size="16" />
          </button>
        </template>
        {{ t('desktop.search.title') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <button class="desktop-task-sidebar__marks-trigger" type="button" :aria-label="t('desktop.marks.manage')" @click="marksOpen = true">
            <DesktopIcon :component="Tag20Regular" :size="16" />
          </button>
        </template>
        {{ t('desktop.marks.manage') }}
      </NTooltip>
      <button
        class="desktop-task-sidebar__new-trigger"
        type="button"
        :aria-label="t('desktop.tasks.newTask')"
        @click="emit('newTask', null)"
      >
        <DesktopIcon :component="Add20Regular" :size="16" />
      </button>
    </header>

    <NAlert v-if="marks.error.value && !marksOpen" type="error" :show-icon="false">
      {{ marks.error.value }}
      <NButton text @click="marks.refresh">
        {{ t('desktop.marks.retry') }}
      </NButton>
    </NAlert>
    <div class="desktop-task-sidebar__content">
      <nav :style="sidebarLayoutStyle">
        <DesktopTaskSidebarSection
          v-if="visiblePinnedItems.length > 0"
          :expanded="isSectionExpanded('pinned')"
          :items="pinnedRows"
          key-field="key"
          :label="t('desktop.tasks.pinnedSection')"
          :priority="DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES.pinned"
          :scroll-index="scrollAnchors.pinned"
          section="pinned"
          @scroll="index => recordScrollAnchor('pinned', index)"
          @update:expanded="value => setSectionExpanded('pinned', value)"
        >
          <template #default="{ item }">
            <div v-if="item.kind === 'space'" class="desktop-task-sidebar__space-item">
              <DesktopTaskSpaceRow
                :dragging="draggedPinnedItemKey === item.pinKey"
                :drop-position="item.pinnedTopLevel ? getPinnedDropPosition(item.pinKey) : undefined"
                :expanded="isSpaceExpanded(item.space.id)"
                :language="language"
                pin-mode="unpin"
                :space="item.space"
                :reorderable="item.pinnedTopLevel"
                reorder-target
                @drag-end="endPinnedDrag"
                @drag-over="enterPinnedDropTarget(item.pinKey!, $event)"
                @drag-start="beginPinnedDrag(item.pinKey!)"
                @drop="dropPinnedItem(item.pinKey!, $event)"
                @menu="selectSpaceMenuAction(item.space, $event)"
                @pin="unpinItem(item.pinKey!)"
                @toggle="toggleSpace(item.space.id)"
              />
            </div>
            <DesktopTaskRow
              v-else
              :task-id="item.task.id"
              :active="item.task.id === activeConversationId"
              :activity="item.task.activity"
              v-bind="markBindings(item.task.id)"
              :dragging="item.pinnedTopLevel && draggedPinnedItemKey === item.pinKey"
              :drop-position="item.pinnedTopLevel ? getPinnedDropPosition(item.pinKey) : undefined"
              :language="language"
              :now="relativeTimeNow"
              :occurred-at="item.task.automationOccurrence?.scheduledFor ?? item.task.updatedAt"
              :pin-mode="item.pinnedTopLevel ? 'unpin' : undefined"
              :space-task="item.spaceTask"
              :reorderable="item.pinnedTopLevel"
              :reorder-target="item.pinnedTopLevel"
              :title="getTaskTitle(item.task)"
              @delete="requestTaskDelete(item.task)"
              @drag-end="endPinnedDrag"
              @drag-over="enterPinnedDropTarget(item.pinKey!, $event)"
              @drag-start="beginPinnedDrag(item.pinKey!)"
              @drop="dropPinnedItem(item.pinKey!, $event)"
              @open="emit('openTask', item.task.id)"
              @pin="unpinItem(item.pinKey!)"
              @rename="requestTaskRename(item.task)"
            />
          </template>
        </DesktopTaskSidebarSection>

        <DesktopTaskSidebarSection
          :expanded="isSectionExpanded('spaces')"
          :items="spaceRows"
          key-field="key"
          :label="t('desktop.tasks.spacesSection')"
          :priority="DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES.spaces"
          :scroll-index="scrollAnchors.spaces"
          section="spaces"
          show-add
          @add="openSpaceCreator"
          @scroll="index => recordScrollAnchor('spaces', index)"
          @update:expanded="value => setSectionExpanded('spaces', value)"
        >
          <template #default="{ item }">
            <div v-if="item.kind === 'space'" class="desktop-task-sidebar__space-item">
              <DesktopTaskSpaceRow
                :expanded="isSpaceExpanded(item.space.id)"
                :language="language"
                pin-mode="pin"
                :space="item.space"
                @menu="selectSpaceMenuAction(item.space, $event)"
                @pin="pinSpace(item.space.id)"
                @toggle="toggleSpace(item.space.id)"
              />
            </div>
            <DesktopTaskRow
              v-else
              :task-id="item.task.id"
              :active="item.task.id === activeConversationId"
              :activity="item.task.activity"
              :language="language"
              :now="relativeTimeNow"
              :occurred-at="item.task.automationOccurrence?.scheduledFor ?? item.task.updatedAt"
              :space-task="item.spaceTask"
              v-bind="markBindings(item.task.id)"
              :title="getTaskTitle(item.task)"
              @delete="requestTaskDelete(item.task)"
              @open="emit('openTask', item.task.id)"
              @rename="requestTaskRename(item.task)"
            />
          </template>
        </DesktopTaskSidebarSection>

        <DesktopTaskSidebarSection
          :expanded="isSectionExpanded('tasks')"
          :items="globalTasks"
          key-field="id"
          :label="t('desktop.tasks.tasksSection')"
          :priority="DESKTOP_TASK_SIDEBAR_SECTION_PRIORITIES.tasks"
          :scroll-index="scrollAnchors.tasks"
          section="tasks"
          @scroll="index => recordScrollAnchor('tasks', index)"
          @update:expanded="value => setSectionExpanded('tasks', value)"
        >
          <template #default="{ item: task }">
            <DesktopTaskRow
              :task-id="task.id"
              :active="task.id === activeConversationId"
              :activity="task.activity"
              v-bind="markBindings(task.id)"
              :language="language"
              :now="relativeTimeNow"
              :occurred-at="task.automationOccurrence?.scheduledFor ?? task.updatedAt"
              pin-mode="pin"
              :title="getTaskTitle(task)"
              @delete="requestTaskDelete(task)"
              @open="emit('openTask', task.id)"
              @pin="pinTask(task.id)"
              @rename="requestTaskRename(task)"
            />
          </template>
        </DesktopTaskSidebarSection>
      </nav>
    </div>

    <DesktopTaskSearchDialog
      v-model:show="searchOpen"
      :conversations="tasks"
      :language="language"
      :spaces="spaces"
      @open-task="openSearchTask"
      @open-space="openSearchSpace"
    />

    <DesktopTaskMarkManager v-model:show="marksOpen" :marks="marks" :language="language" />

    <DesktopSpaceDialog
      v-model:show="spaceDialogOpen"
      :language="language"
      :space="spaceEditTarget"
      :select-directory="selectSpaceDirectory"
      :save="saveSpace"
    />

    <NModal
      :show="spaceDeleteTarget !== null"
      preset="dialog"
      type="warning"
      :title="t('desktop.tasks.deleteSpaceTitle')"
      @update:show="!$event && (spaceDeleteTarget = null)"
    >
      <div class="desktop-task-sidebar__delete-space-content">
        <p>
          {{ t('desktop.tasks.deleteSpaceMessage', { name: spaceDeleteTarget?.name ?? '' }) }}
        </p>
        <NAlert
          v-if="spaceDeleteTarget && spaceDeleteTarget.activeRunCount > 0"
          :show-icon="false"
          type="warning"
        >
          {{ t('desktop.tasks.deleteSpaceActiveRunWarning', { count: spaceDeleteTarget.activeRunCount }) }}
        </NAlert>
        <p v-else class="desktop-task-sidebar__delete-space-retention">
          {{ t('desktop.tasks.deleteSpaceRetention') }}
        </p>
      </div>
      <template #action>
        <NButton @click="spaceDeleteTarget = null">
          {{ spaceDeleteTarget && spaceDeleteTarget.activeRunCount > 0 ? t('common.close') : t('common.cancel') }}
        </NButton>
        <NButton
          v-if="spaceDeleteTarget && spaceDeleteTarget.activeRunCount === 0"
          type="error"
          @click="confirmSpaceDelete"
        >
          {{ t('common.delete') }}
        </NButton>
      </template>
    </NModal>

    <NModal
      :show="taskRenameTarget !== null"
      preset="dialog"
      :title="t('desktop.tasks.renameTask')"
      @update:show="!$event && (taskRenameTarget = null)"
    >
      <div class="desktop-task-sidebar__rename-content">
        <NInput
          v-model:value="taskTitleDraft"
          maxlength="80"
          show-count
          autofocus
          @keyup.enter="confirmTaskRename"
        />
      </div>
      <template #action>
        <NButton @click="taskRenameTarget = null">
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          type="primary"
          :disabled="!taskTitleDraft.trim()"
          @click="confirmTaskRename"
        >
          {{ t('common.save') }}
        </NButton>
      </template>
    </NModal>

    <NModal
      :show="taskDeleteTarget !== null"
      preset="dialog"
      type="warning"
      :title="t('desktop.tasks.deleteTaskConfirmTitle')"
      @update:show="!$event && (taskDeleteTarget = null)"
    >
      {{ t('desktop.tasks.deleteTaskConfirmMessage', { title: taskDeleteTarget ? getTaskTitle(taskDeleteTarget) : '' }) }}
      <template #action>
        <NButton @click="taskDeleteTarget = null">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="error" @click="confirmTaskDelete">
          {{ t('common.delete') }}
        </NButton>
      </template>
    </NModal>
  </aside>
</template>

<style scoped lang="scss">
.desktop-task-sidebar {
  display: flex;
  width: var(--buddy-workspace-sidebar-width);
  height: 100%;
  min-height: 0;
  flex: none;
  flex-direction: column;
  border-right: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-workspace-sidebar);
}

.desktop-task-sidebar__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.25rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 0.5rem 0 0.75rem;
}

.desktop-task-sidebar__new-trigger,
.desktop-task-sidebar__search-trigger,
.desktop-task-sidebar__marks-trigger {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  place-items: center;
  border: 0;
  padding: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: pointer;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.desktop-task-sidebar__content {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 0.5rem 0;
}

.desktop-task-sidebar nav {
  --buddy-task-sidebar-section-gap: 0.25rem;
  --buddy-task-sidebar-section-font-size: 13px;
  --buddy-task-sidebar-item-font-size: 13px;
  --buddy-task-sidebar-action-gap: 0.125rem;
  --buddy-task-sidebar-action-inset: 0.4rem;
  --buddy-task-sidebar-action-size: 1.5rem;
  --buddy-task-sidebar-scrollbar-gutter: 0.5rem;
  --buddy-task-sidebar-state-radius: 6px;

  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  gap: var(--buddy-task-sidebar-section-gap);
  overflow: hidden;
}

.desktop-task-sidebar__space-item {
  height: var(--buddy-task-sidebar-row-size);
  padding-right: var(--buddy-task-sidebar-scrollbar-gutter);
  padding-bottom: calc(var(--buddy-task-sidebar-row-size) - var(--buddy-task-sidebar-row-height));
  padding-left: var(--buddy-task-sidebar-scrollbar-gutter);
}

.desktop-task-sidebar__rename-content {
  margin-top: 0.75rem;
}

.desktop-task-sidebar__delete-space-content {
  display: grid;
  gap: 0.85rem;
}

.desktop-task-sidebar__delete-space-content p {
  margin: 0;
  line-height: 1.65;
}

.desktop-task-sidebar__delete-space-retention {
  color: var(--buddy-text-secondary);
  font-size: 0.75rem;
}
</style>
