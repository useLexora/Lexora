<script setup lang="ts">
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import { computed } from 'vue'
import { DesktopTaskIndexView } from '@/modules/tasks/ui'
import WorkbenchMountPoint from '@/workbench/browser/mounts/WorkbenchMountPoint.vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = defineProps<{ bindings: DesktopShellBindings }>()
const emit = defineEmits<{ navigate: [] }>()
defineSlots<{ footer?: () => unknown }>()
const { controller, revision } = useWorkbench()
const pendingTaskIds = computed(() => {
  void revision.value
  return [...controller.navigation.entries.values()].filter(entry => entry.status === 'loading' && entry.view.resource.scheme === 'task').map(entry => entry.view.resource.id)
})
function openTask(id: string) {
  emit('navigate')
  void props.bindings.workbench.openTask(id)
}
function newTask(spaceId: string | null = null) {
  emit('navigate')
  void props.bindings.workbench.newTask({ spaceId })
}
</script>

<template>
  <div id="desktop-task-history" class="desktop-task-history flex h-full min-h-0 min-w-0 flex-1 flex-col bg-workspace-sidebar">
    <WorkbenchMountPoint target="workbench.sidebar">
      <DesktopTaskIndexView :pending-task-ids="pendingTaskIds" :index="bindings.taskIndex" :active-task-id="bindings.workbench.activeTaskId.value" @open-task="openTask" @new-task="newTask" />
    </WorkbenchMountPoint>
    <slot name="footer" />
  </div>
</template>
