<script setup lang="ts">
import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'

import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { TaskIndex, TaskMarks } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskSpaceInput } from '@/modules/tasks/state/task-index/typing'
import { Add20Regular, Tag20Regular } from '@vicons/fluent'
import { NAlert, NButton, NInput, NModal, NTooltip, useMessage } from 'naive-ui'
import { computed, shallowRef, toRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceDialog from '@/modules/tasks/widgets/task-index/DesktopSpaceDialog.vue'
import DesktopTaskSearchDialog from '@/modules/tasks/widgets/task-index/DesktopTaskSearchDialog.vue'
import { useTaskIndexController } from '@/modules/tasks/widgets/task-index/useTaskIndexController'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopWorkspaceSidebarIdentity from '@/shared/ui/workspace-sidebar/DesktopWorkspaceSidebarIdentity.vue'
import DesktopTaskHistoryList from './DesktopTaskHistoryList.vue'
import DesktopTaskMarkManager from './DesktopTaskMarkManager.vue'
import DesktopTaskMoveToSpaceDialog from './DesktopTaskMoveToSpaceDialog.vue'

const props = defineProps<{
  activeConversationId: string | null
  pendingConversationIds?: readonly string[]
  marks: TaskMarks
  appSidebarCollapsed: boolean
  language: BuddyLocale
  pinnedItems: ReadonlyArray<DesktopTaskPinnedItem>
  sidebar: TaskIndex['sidebar']
  history: TaskIndex['history']
  spaces: ReadonlyArray<LocalSpace>
  selectSpaceDirectory: () => Promise<string | null>
  createSpace: (input: TaskSpaceInput) => Promise<boolean>
  moveTaskToSpace: (taskId: string, spaceId: string) => Promise<boolean>
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
const message = useMessage()
const taskMoveTargetId = shallowRef<string | null>(null)
const taskMoveTarget = computed(() => props.tasks.find(task => task.id === taskMoveTargetId.value) ?? null)
const taskMoveBusy = computed(() => Boolean(taskMoveTargetId.value && props.pendingConversationIds?.includes(taskMoveTargetId.value)))
const moveTargets = computed(() => props.spaces
  .filter(space => space.revokedAt === null)
  .map(space => ({ id: space.id, name: space.name })))
function moveToSpaceAvailable(task: LocalConversationSummary) {
  if (task.spaceId !== null)
    return undefined
  return moveTargets.value.length > 0 && task.activity === 'idle' && !props.pendingConversationIds?.includes(task.id)
}
function revealMovedTask(spaceId: string) {
  void props.sidebar.setSectionExpanded('spaces', true)
  void props.sidebar.setSpaceExpanded(spaceId, true)
}
const controller = useTaskIndexController({
  activeConversationId: () => props.activeConversationId,
  history: () => props.history,
  onHistoryError: () => message.error(t('desktop.tasks.historyLoadFailed')),
  getUntitledLabel: () => t('desktop.tasks.untitled'),
  markStates: () => props.marks.states.value,
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

const sections = computed<DesktopTaskSidebarSection[]>(() => controller.pinnedItems.value.length
  ? ['pinned', 'spaces', 'tasks']
  : ['spaces', 'tasks'])

const {
  confirmTaskDelete,
  confirmTaskRename,
  confirmSpaceDelete,
  getTaskTitle,
  spaceDeleteTarget,
  spaceDialogOpen,
  spaceEditTarget,
  saveSpace,
  taskDeleteTarget,
  taskRenameTarget,
  taskTitleDraft,
} = controller

async function openSearchTask(conversation: LocalConversationSummary) {
  if (!await controller.revealTask(conversation) || !searchOpen.value)
    return
  searchOpen.value = false
  emit('openTask', conversation.id)
}

function openSearchSpace(spaceId: string) {
  searchOpen.value = false
  emit('newTask', spaceId)
}
</script>

<template>
  <aside class="desktop-task-sidebar flex w-workspace-sidebar h-full min-h-0 flex-none flex-col border-r-1 border-r-solid border-r-border bg-workspace-sidebar text-workspace-sidebar-fg" data-theme-surface="layout">
    <header class="flex flex-none items-center justify-between gap-1 border-b-1 border-b-solid border-b-border pt-0 pr-2 pb-0 pl-3 h-region-header">
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
    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden py-2 px-0">
      <DesktopTaskHistoryList
        v-for="section in sections"
        :key="section"
        :section="section"
        :active-conversation-id="activeConversationId"
        :pending-conversation-ids="pendingConversationIds"
        :controller="controller"
        :language="language"
        :marks="marks"
        :move-to-space-available="moveToSpaceAvailable"
        @open-task="emit('openTask', $event)"
        @manage-marks="marksOpen = true"
        @move-task="taskMoveTargetId = $event"
      />
    </nav>

    <DesktopTaskSearchDialog
      v-model:show="searchOpen"
      :search="(query, cursor) => history.search(query, cursor)"
      :language="language"
      :spaces="spaces"
      @open-task="openSearchTask"
      @open-space="openSearchSpace"
    />

    <DesktopTaskMarkManager v-model:show="marksOpen" :marks="marks" :language="language" />

    <DesktopTaskMoveToSpaceDialog
      :show="taskMoveTargetId !== null"
      :task="taskMoveTarget"
      :busy="taskMoveBusy"
      :language="language"
      :spaces="moveTargets"
      :move-task-to-space="moveTaskToSpace"
      @update:show="!$event && (taskMoveTargetId = null)"
      @moved="revealMovedTask"
    />

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
      <div class="desktop-task-sidebar__delete-space-content grid gap-[0.85rem]">
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
        <p v-else class="text-muted text-[0.75rem]">
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
      <div class="mt-3">
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

.desktop-task-sidebar__delete-space-content p {
  margin: 0;
  line-height: 1.65;
}
</style>
