<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { TaskCapability } from '@/modules/tasks'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { Add20Regular } from '@vicons/fluent'
import { useMessage } from 'naive-ui'
import { computed, h, inject, onScopeDispose, shallowRef, watch } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { useTaskEnvironment } from '@/modules/tasks'
import { DesktopTaskEditor, DesktopTaskViewProvider } from '@/modules/tasks/ui'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useTaskErrorMessage } from '@/shared/ui/useTaskErrorMessage'
import WorkbenchPaneActions from '@/workbench/browser/WorkbenchPaneActions.vue'
import WorkbenchPaneTitle from '@/workbench/browser/WorkbenchPaneTitle.vue'
import { resourceKey } from '@/workbench/common/workbench'
import DesktopTaskLoading from './DesktopTaskLoading.vue'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'
import { draftResource, parseTaskResource } from './taskResource'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const workbench = useDesktopWorkbenchContext()
const environment = useTaskEnvironment()
const task = shallowRef<TaskCapability | null>(null)
const failed = shallowRef(false)
const editorReady = shallowRef(false)
const runtime = inject(runtimeAvailabilityKey, null)
// Keep the panel's maintenance and recovery UI reachable during the initial load.
const editorTask = computed(() => editorReady.value || runtime?.loading.value || runtime?.failed.value ? task.value : null)
const taskResource = computed(() => parseTaskResource(props.view.resource))
const notificationTargetMessageId = computed(() => {
  const target = environment.notificationTarget.value
  return target?.conversationId === task.value?.session.activeTaskId.value
    && target?.branchId === task.value?.workspace.session.activeBranchId.value
    ? target?.messageId ?? null
    : null
})
const context = computed(() => ({ ...environment, notificationTargetMessageId, tasks: task.value!, startTask: (spaceId: string | null = null) => task.value!.session.startTask(spaceId) }))
const message = useMessage()
const showTaskError = useTaskErrorMessage()
const newTaskActions = computed<DropdownOption[]>(() => {
  const command = workbench.controller.registry.commands.get('task.newInSpace')
  return command
    ? [{
        key: command.id,
        label: translateBuddy(workbench.language.value, 'desktop.tasks.newTask'),
        icon: () => h(DesktopIcon, { component: Add20Regular }),
        disabled: !task.value,
      }]
    : []
})
async function selectAction(key: string | number, fallback?: (key: string | number) => void) {
  if (key !== 'task.newInSpace') {
    fallback?.(key)
    return
  }
  const paneId = workbench.controller.owner(props.view.id)?.id
  if (!paneId)
    return
  try {
    await workbench.controller.commands.execute(key, { source: 'menu', paneId })
  }
  catch {
    message.error(translateBuddy(workbench.language.value, 'desktop.command.failed'))
  }
}
watch(() => task.value?.workspace.status.isLoading.value, (loading) => {
  if (loading === false)
    editorReady.value = true
}, { flush: 'sync' })
watch(() => task.value?.workspace.status.errorMessage.value, (error) => {
  if (error) {
    showTaskError(error)
    task.value?.workspace.status.dismissError()
  }
})
watch(() => task.value?.session.spaceId.value, (spaceId) => {
  if (taskResource.value?.scheme === 'draft' && task.value && taskResource.value.data.spaceId !== spaceId)
    workbench.controller.updateView(props.view.id, { resource: draftResource(taskResource.value.id, spaceId ?? null) })
})
let loadVersion = 0
onScopeDispose(() => loadVersion++)
async function load() {
  const resource = taskResource.value
  if (!resource)
    return
  const version = ++loadVersion
  failed.value = false
  const matchesTask = task.value && resource.scheme === 'task'
    && task.value.session.activeTaskId.value === resource.id
    && (resource.data.branchId === undefined || task.value.workspace.session.activeBranchId.value === resource.data.branchId)
  if (!matchesTask) {
    task.value = null
    editorReady.value = false
  }
  try {
    const loaded = await workbench.pool.open(resource)
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
watch(() => resourceKey(props.view.resource), load, { immediate: true })
watch(() => task.value?.session.currentTitle.value, (title) => {
  if (title)
    workbench.controller.updateView(props.view.id, { title })
})
</script>

<template>
  <DesktopTaskViewProvider v-if="editorTask" :context="context">
    <DesktopTaskEditor :active="visible" :reading-positions="workbench.readingPositions" @ready="workbench.controller.navigation.ready(view.id)">
      <template #title>
        <WorkbenchPaneTitle :view="view" />
      </template>
      <template #actions="{ options, select, label }">
        <WorkbenchPaneActions :view-id="view.id" :actions="[...options, ...newTaskActions]" :label="label" @select="selectAction($event, select)" @split="workbench.newTask({ spaceId: editorTask.session.spaceId.value, paneId: workbench.controller.owner(view.id)?.id, direction: $event })" />
      </template>
    </DesktopTaskEditor>
  </DesktopTaskViewProvider>
  <DesktopTaskLoading v-else :key="`${view.resource.scheme}:${view.resource.id}`" :failed="failed" @retry="load">
    <template #title>
      <WorkbenchPaneTitle :view="view" />
    </template>
    <template #actions>
      <WorkbenchPaneActions :view-id="view.id" :actions="newTaskActions" @select="selectAction($event)" @split="workbench.newTask({ spaceId: task ? task.session.spaceId.value : taskResource?.scheme === 'draft' ? taskResource.data.spaceId : null, paneId: workbench.controller.owner(view.id)?.id, direction: $event })" />
    </template>
  </DesktopTaskLoading>
</template>
