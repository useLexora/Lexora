<script setup lang="ts">
import type { TaskCapability } from '@/modules/tasks'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useTaskEnvironment } from '@/modules/tasks'
import { DesktopTaskEditor, DesktopTaskViewProvider } from '@/modules/tasks/ui'
import WorkbenchPaneActions from '@/workbench/browser/WorkbenchPaneActions.vue'
import WorkbenchPaneTitle from '@/workbench/browser/WorkbenchPaneTitle.vue'
import DesktopTaskLoading from './DesktopTaskLoading.vue'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const workbench = useDesktopWorkbenchContext()
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
let loadVersion = 0
onScopeDispose(() => loadVersion++)
async function load() {
  if (!taskResource.value)
    return
  const version = ++loadVersion
  failed.value = false
  try {
    const loaded = await workbench.pool.open(props.view.resource)
    if (version !== loadVersion)
      return
    task.value = loaded
  }
  catch {
    if (version === loadVersion) {
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
</script>

<template>
  <DesktopTaskViewProvider v-if="task" :context="context">
    <DesktopTaskEditor :active="visible" :reading-positions="workbench.readingPositions" @ready="workbench.controller.navigation.ready(view.id)">
      <template #title>
        <WorkbenchPaneTitle :view="view" />
      </template>
      <template #actions="{ options, select, label }">
        <WorkbenchPaneActions :view-id="view.id" :actions="options" :label="label" @select="select" @split="workbench.newTask(task.session.spaceId.value, workbench.controller.owner(view.id)?.id, $event)" />
      </template>
    </DesktopTaskEditor>
  </DesktopTaskViewProvider>
  <DesktopTaskLoading v-else :failed="failed" @retry="load">
    <template #title>
      <WorkbenchPaneTitle :view="view" />
    </template>
    <template #actions>
      <WorkbenchPaneActions :view-id="view.id" @split="workbench.newTask(typeof view.resource.data.spaceId === 'string' ? view.resource.data.spaceId : null, workbench.controller.owner(view.id)?.id, $event)" />
    </template>
  </DesktopTaskLoading>
</template>
