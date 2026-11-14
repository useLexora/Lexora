<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { TaskCapability } from '@/modules/tasks'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { Add20Regular } from '@vicons/fluent'
import { useMessage } from 'naive-ui'
import { computed, h, onScopeDispose, shallowRef, watch } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { useTaskEnvironment } from '@/modules/tasks'
import { DesktopTaskEditor, DesktopTaskViewProvider } from '@/modules/tasks/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
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
watch(() => task.value?.workspace.status.errorMessage.value, (error) => {
  if (error) {
    message.error(error)
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
watch(() => resourceKey(props.view.resource), load, { immediate: true })
watch(() => {
  const current = task.value
  const title = current?.session.currentTitle.value
  if (!current || !title)
    return title
  const branches = [...current.workspace.transcript.branches.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const index = branches.findIndex(branch => branch.id === current.workspace.session.activeBranchId.value)
  if (branches.length < 2 || index < 0)
    return title
  const label = translateBuddy(workbench.language.value, index === 0 ? 'desktop.chat.originalBranch' : 'desktop.chat.numberedBranch', { index: index + 1 })
  return `${title} · ${label}`
}, (title) => {
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
        <WorkbenchPaneActions :view-id="view.id" :actions="[...options, ...newTaskActions]" :label="label" @select="selectAction($event, select)" @split="workbench.newTask({ spaceId: task.session.spaceId.value, paneId: workbench.controller.owner(view.id)?.id, direction: $event })" />
      </template>
    </DesktopTaskEditor>
  </DesktopTaskViewProvider>
  <DesktopTaskLoading v-else :failed="failed" @retry="load">
    <template #title>
      <WorkbenchPaneTitle :view="view" />
    </template>
    <template #actions>
      <WorkbenchPaneActions :view-id="view.id" :actions="newTaskActions" @select="selectAction($event)" @split="workbench.newTask({ spaceId: taskResource?.scheme === 'draft' ? taskResource.data.spaceId : null, paneId: workbench.controller.owner(view.id)?.id, direction: $event })" />
    </template>
  </DesktopTaskLoading>
</template>
