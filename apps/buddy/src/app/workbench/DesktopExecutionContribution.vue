<script setup lang="ts">
import type { ExecutionTarget } from '@buddy-shared/executions/executionPresentationApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { executionTargetSchema } from '@buddy-shared/executions/executionPresentationApi'
import { useElementSize } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { useProvideArtifactActions, useProvideChatContent, useTaskEnvironment } from '@/modules/tasks'
import { DesktopExecutionDetail } from '@/modules/tasks/ui'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const message = useMessage()
const workbench = useDesktopWorkbenchContext()
const presentation = useWorkbench()
const surface = computed(() => presentation.viewTarget(props.view.id)?.closest<HTMLElement>('.desktop-workbench-layout') ?? null)
const sidebar = computed(() => surface.value?.querySelector<HTMLElement>(':scope > .desktop-workbench-layout__sidebar') ?? null)
const { width } = useElementSize(surface)
const { width: sidebarWidth } = useElementSize(sidebar)
const availableWidth = computed(() => width.value - sidebarWidth.value)
const adapted = shallowRef(false)
watch(() => [props.visible, availableWidth.value] as const, ([visible, available]) => {
  if (!visible || available <= 0)
    return
  if (available < 700 && !presentation.panels.contextMaximized.value) {
    adapted.value = true
    presentation.panels.toggleMaximize()
  }
  else if (available >= 700 && adapted.value) {
    adapted.value = false
    presentation.panels.restore()
  }
}, { immediate: true })
onScopeDispose(() => {
  if (adapted.value)
    presentation.panels.restore()
})
const { clipboard, resources } = useTaskEnvironment()
const target = computed<ExecutionTarget | null>((previous) => {
  const value = executionTargetSchema.safeParse(props.view.resource.data)
  if (!value.success)
    return null
  return previous && Object.entries(previous).every(([key, field]) => value.data[key as keyof ExecutionTarget] === field) ? previous : value.data
})
useProvideArtifactActions({
  task: () => props.visible && target.value?.conversationId === workbench.activeTaskId.value ? workbench.activeTask.value : null,
  resources,
  revealFile: input => workbench.api.localChat.artifacts.revealFile(input),
  writeClipboardText: clipboard.writeText,
  language: () => workbench.language.value,
})
useProvideChatContent({
  openWebLink: (url) => {
    if (target.value)
      void resources.openWebLink(url, { conversationId: target.value.conversationId, runId: target.value.runId })
  },
  writeClipboardText: clipboard.writeText,
  canPreviewFile: path => target.value?.conversationId === workbench.activeTaskId.value && resources.canPreviewFile(path),
  previewFile: (path) => {
    if (target.value?.conversationId === workbench.activeTaskId.value)
      resources.previewFile(path, { conversationId: target.value.conversationId, runId: target.value.runId })
  },
})
async function returnToTask() {
  const input = target.value
  if (!input)
    return
  try {
    await workbench.openTask(input.conversationId)
    presentation.panels.restore()
  }
  catch {
    message.error(translateBuddy(workbench.language.value, 'desktop.command.failed'))
  }
}

async function openArtifact(id: string) {
  const input = target.value
  if (!input)
    return
  try {
    const detail = await workbench.api.localChat.executions.detail(input)
    const artifact = detail.artifacts.find(item => item.artifactId === id)
    if (artifact && props.visible && target.value?.runId === input.runId)
      await resources.openArtifact(artifact)
  }
  catch {
    message.error(translateBuddy(workbench.language.value, 'desktop.command.failed'))
  }
}
async function openChanges() {
  const input = target.value
  if (!input)
    return
  try {
    const detail = await workbench.api.localChat.executions.detail(input)
    if (detail.changes && props.visible && target.value?.runId === input.runId)
      resources.openChanges(detail.changes, { conversationId: input.conversationId, runId: input.runId }, detail.run.branchId)
  }
  catch {
    message.error(translateBuddy(workbench.language.value, 'desktop.command.failed'))
  }
}
</script>

<template>
  <DesktopExecutionDetail v-if="target" :key="view.resource.id" :target="target" :visible="visible" :language="workbench.language.value" @title-change="workbench.controller.updateView(view.id, { title: $event })" @open-artifact="openArtifact" @open-changes="openChanges" @return-to-task="returnToTask" />
</template>
