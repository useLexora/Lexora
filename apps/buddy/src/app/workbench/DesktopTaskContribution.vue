<script setup lang="ts">
import type { TaskCapability } from '@/modules/tasks'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useTaskEnvironment } from '@/modules/tasks'
import { DesktopTaskEditor, DesktopTaskViewProvider } from '@/modules/tasks/ui'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import WorkbenchPaneActions from '@/workbench/browser/WorkbenchPaneActions.vue'
import WorkbenchPaneTitle from '@/workbench/browser/WorkbenchPaneTitle.vue'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const workbench = useDesktopWorkbenchContext()
const { labels } = useWorkbench()
const environment = useTaskEnvironment()
const task = shallowRef<TaskCapability | null>(null)
const failed = shallowRef(false)
const taskResource = computed(() => ['task', 'draft'].includes(props.view.resource.scheme))
const notificationTargetMessageId = computed(() => environment.notificationTarget.value?.conversationId === task.value?.session.activeTaskId.value ? environment.notificationTarget.value?.messageId ?? null : null)
const context = computed(() => ({ ...environment, notificationTargetMessageId, tasks: task.value!, startTask: (spaceId: string | null = null) => task.value!.session.startTask(spaceId) }))
const message = useMessage()
watch(() => task.value?.workspace.status.errorMessage.value, (error) => {
  if (error) {
    message.error(error)
    task.value?.workspace.status.dismissError()
  }
})
watch(() => task.value?.session.spaceId.value, (spaceId) => {
  if (props.view.resource.scheme === 'draft' && task.value && props.view.resource.data.spaceId !== spaceId)
    workbench.controller.updateView(props.view.id, { resource: { ...props.view.resource, data: { spaceId: spaceId ?? null } } })
})
let disposed = false
onScopeDispose(() => disposed = true)
async function load() {
  if (!taskResource.value)
    return
  failed.value = false
  try {
    const loaded = await workbench.pool.open(props.view.resource)
    if (disposed)
      return
    task.value = loaded
    if (props.visible && workbench.controller.owner(props.view.id)?.id === workbench.controller.layout.activePane)
      workbench.activeTask.value = loaded
  }
  catch {
    if (!disposed) {
      failed.value = true
      workbench.controller.navigation.fail(props.view.id)
    }
  }
}
watch(() => props.view.resource.id, load, { immediate: true })
watch(() => task.value?.session.currentTitle.value, (title) => {
  if (title)
    workbench.controller.updateView(props.view.id, { title })
})
watch(() => props.visible, (visible) => {
  if (visible && task.value && workbench.controller.context.view?.id === props.view.id)
    workbench.activeTask.value = task.value
})
</script>

<template>
  <DesktopTaskViewProvider v-if="task" :context="context">
    <DesktopTaskEditor :active="visible" :reading-positions="workbench.readingPositions" @ready="workbench.controller.navigation.ready(view.id)">
      <template #title>
        <WorkbenchPaneTitle :view="view" />
      </template>
      <template #actions>
        <WorkbenchPaneActions :view-id="view.id" @split="workbench.newTask(task.session.spaceId.value, workbench.controller.owner(view.id)?.id, $event)" />
      </template>
    </DesktopTaskEditor>
  </DesktopTaskViewProvider>
  <div v-else class="desktop-workbench-view__fallback">
    <span>{{ failed ? labels.failed : labels.loading }}</span><button v-if="failed" type="button" @click="load">
      {{ labels.retry }}
    </button>
  </div>
</template>

<style scoped>
.desktop-workbench-view__fallback { margin: auto; display: flex; gap: 12px; color: var(--buddy-text-secondary); }
.desktop-workbench-view__output { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; font-size: 11px; }
.desktop-workbench-view__run { display: flex; gap: 14px; padding: 3px 0; color: var(--buddy-text-secondary); }
.desktop-workbench-view__run code { overflow: hidden; text-overflow: ellipsis; }
</style>
