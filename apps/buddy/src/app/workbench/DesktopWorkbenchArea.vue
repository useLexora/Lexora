<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import { computed, useTemplateRef, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { DesktopTaskResourcePanel } from '@/modules/tasks/ui'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import WorkbenchLayout from '@/workbench/browser/layout/WorkbenchLayout.vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import WorkbenchLayoutNode from '@/workbench/browser/WorkbenchLayoutNode.vue'
import WorkbenchResourcePanelActions from '@/workbench/browser/WorkbenchResourcePanelActions.vue'
import WorkbenchSurface from '@/workbench/browser/WorkbenchSurface.vue'
import DesktopDirectoryFileSurface from './DesktopDirectoryFileSurface.vue'
import DesktopTaskHistory from './DesktopTaskHistory.vue'

const props = defineProps<{ bindings: DesktopShellBindings, tasksVisible: boolean }>()
defineSlots<{ 'sidebar-footer'?: () => unknown }>()
const taskWorkspace = useTemplateRef<HTMLElement>('taskWorkspace')
useWorkbenchAnchor('workbench.workspace', () => taskWorkspace.value)
const { layout, revision, labels, panels } = useWorkbench()
const route = useRoute()
const contextVisible = computed(() => props.bindings.lifecycle.state.value.hasBeenReady && (props.tasksVisible || props.bindings.contextPanelGlobal.value) && props.bindings.resources.isOpen.value)
watch([contextVisible, () => route.path], panels.restore)
const { language } = useDesktopUi()
const sidebar = props.bindings.taskIndex.sidebar
const collapsed = computed({ get: () => sidebar.collapsed.value, set: value => void sidebar.setCollapsed(value) })
const width = computed({ get: () => sidebar.width.value, set: value => void sidebar.setWidth(value) })
const fileTab = computed(() => props.bindings.resources.activeTab.value?.kind === 'files' ? props.bindings.resources.activeTab.value : null)
const selectedFile = computed(() => {
  void revision.value
  return fileTab.value ? props.bindings.workbench.fileView(fileTab.value.target, fileTab.value.id) : null
})
watch(() => fileTab.value?.target, (target) => {
  if (target?.path && fileTab.value)
    void props.bindings.workbench.openFile({ ...target }, fileTab.value.id)
}, { immediate: true })
watch(() => selectedFile.value?.id, (id) => {
  if (id && props.bindings.workbench.controller.context.values['focus.area'] === 'context')
    props.bindings.workbench.controller.focus(id)
})
function toolbarTarget(id: string, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement)
    props.bindings.workbench.fileToolbarTargets.set(id, element)
  else
    props.bindings.workbench.fileToolbarTargets.delete(id)
}
function focusContext() {
  const tab = props.bindings.resources.activeTab.value
  props.bindings.workbench.controller.focusContext(tab?.kind === 'view' ? tab.viewId : selectedFile.value?.id ?? null)
}
</script>

<template>
  <WorkbenchLayout v-model:sidebar-collapsed="collapsed" v-model:sidebar-width="width" :language="language" :context-visible="contextVisible" :context-on-left="panels.contextOnLeft.value" :context-maximized="panels.contextMaximized.value" :sidebar-collapsible="tasksVisible" :sidebar-resizable="tasksVisible" :sidebar-toggle-visible="bindings.navigationLayout.value === 'full'">
    <template v-if="tasksVisible" #sidebar>
      <DesktopTaskHistory :bindings="bindings">
        <template #footer>
          <slot name="sidebar-footer" />
        </template>
      </DesktopTaskHistory>
    </template>
    <template #workspace>
      <div v-show="tasksVisible" ref="taskWorkspace" class="desktop-workbench-area__tasks relative flex flex-1 min-w-0 min-h-0" data-theme-surface="layout" data-workbench-workspace>
        <WorkbenchLayoutNode :node="layout.root" />
      </div>
      <RouterView v-if="!tasksVisible" />
    </template>
    <template #context>
      <div class="flex flex-1 min-w-0 min-h-0" data-workbench-context @focusin="focusContext" @pointerdown="focusContext">
        <DesktopTaskResourcePanel :panel="bindings.resources" :context="bindings.resourceContext" :language="language" :visible="contextVisible">
          <template #header-actions>
            <WorkbenchResourcePanelActions :language="language" :maximized="panels.contextMaximized.value" :on-left="panels.contextOnLeft.value" :can-swap="tasksVisible" @swap="panels.swap" @toggle-maximize="panels.toggleMaximize" />
          </template>
          <template #view="{ viewId }">
            <WorkbenchSurface :view-id="viewId" :visible="contextVisible" />
          </template>
          <template #file-toolbar="{ tab }">
            <div :ref="element => toolbarTarget(tab.id, element)" class="flex min-w-0 flex-1" />
          </template>
          <template #file="{ wrap, setWrap }">
            <DesktopDirectoryFileSurface v-if="selectedFile" :view="selectedFile" :wrap="wrap" :visible="contextVisible" @update-wrap="setWrap" />
            <DesktopFileLoading v-else :key="fileTab?.target.path" :loading="true" :label="labels.loading" />
          </template>
        </DesktopTaskResourcePanel>
      </div>
    </template>
  </WorkbenchLayout>
</template>

<style scoped lang="scss">
.desktop-workbench-area__tasks > :deep(*) { flex: 1; }
</style>
