<script setup lang="ts">
import type { TaskIndex } from '../../contracts'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopTaskIndex from '../task-index/DesktopTaskIndex.vue'

defineProps<{ activeTaskId: string | null, pendingTaskIds?: readonly string[], index: TaskIndex }>()
const emit = defineEmits<{ openTask: [id: string], newTask: [spaceId?: string | null] }>()
const { language, appSidebarCollapsed } = useDesktopUi()
</script>

<template>
  <DesktopTaskIndex
    :pending-conversation-ids="pendingTaskIds"
    :active-conversation-id="activeTaskId"
    :marks="index.marks"
    :app-sidebar-collapsed="appSidebarCollapsed"
    :language="language"
    :pinned-items="index.pinnedItems.value"
    :sidebar="index.sidebar"
    :history="index.history"
    :archive="index.archive"
    :spaces="index.spaces.value"
    :select-space-directory="index.selectSpaceDirectory"
    :tasks="index.tasks.value"
    :activities="index.activities.value"
    :create-space="index.createSpace"
    :move-task-to-space="index.moveTaskToSpace"
    :update-space="index.updateSpace"
    @delete-space="index.deleteSpace"
    @delete-task="index.deleteTask"
    @new-task="emit('newTask', $event)"
    @open-space-directory="index.openSpaceDirectory"
    @open-task="emit('openTask', $event)"
    @rename-task="index.renameTask"
    @update-pinned-items="index.setPinnedItems"
  />
</template>
