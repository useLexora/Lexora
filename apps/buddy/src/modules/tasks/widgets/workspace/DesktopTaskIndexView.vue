<script setup lang="ts">
import type { TaskIndex } from '../../contracts'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopTaskIndex from '../task-index/DesktopTaskIndex.vue'

const props = defineProps<{ activeTaskId: string | null, pendingTaskIds?: readonly string[], index: TaskIndex }>()
const emit = defineEmits<{ openTask: [id: string], newTask: [spaceId?: string | null] }>()
const { language, appSidebarCollapsed } = useDesktopUi()
const { pinnedItems, sidebar, spaces, tasks: items, ...actions } = props.index
</script>

<template>
  <DesktopTaskIndex :pending-conversation-ids="pendingTaskIds" :active-conversation-id="activeTaskId" :marks="index.marks" :app-sidebar-collapsed="appSidebarCollapsed" :language="language" :pinned-items="pinnedItems" :sidebar="sidebar" :spaces="spaces" :select-space-directory="actions.selectSpaceDirectory" :tasks="items" :create-space="actions.createSpace" :update-space="actions.updateSpace" @delete-space="actions.deleteSpace" @delete-task="actions.deleteTask" @new-task="emit('newTask', $event)" @open-space-directory="actions.openSpaceDirectory" @open-task="emit('openTask', $event)" @rename-task="actions.renameTask" @update-pinned-items="actions.setPinnedItems" />
</template>
