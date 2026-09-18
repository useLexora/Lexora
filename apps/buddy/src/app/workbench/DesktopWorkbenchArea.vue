<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import { NSpin } from 'naive-ui'
import { computed, watch } from 'vue'
import { RouterView } from 'vue-router'
import { DesktopTaskIndexView, DesktopTaskResourcePanel } from '@/modules/tasks/ui'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopWorkbenchLayout from '@/shared/ui/workbench-layout/DesktopWorkbenchLayout.vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import WorkbenchLayoutNode from '@/workbench/browser/WorkbenchLayoutNode.vue'
import WorkbenchSurface from '@/workbench/browser/WorkbenchSurface.vue'
import DesktopDirectoryFileSurface from './DesktopDirectoryFileSurface.vue'

const props = defineProps<{ bindings: DesktopShellBindings, tasksVisible: boolean }>()
const { layout, revision, labels } = useWorkbench()
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
  <DesktopWorkbenchLayout v-model:sidebar-collapsed="collapsed" v-model:sidebar-width="width" :language="language" :context-visible="(tasksVisible || bindings.contextPanelGlobal.value) && bindings.resources.isOpen.value" :sidebar-collapsible="tasksVisible" :sidebar-resizable="tasksVisible">
    <template v-if="tasksVisible" #sidebar>
      <DesktopTaskIndexView :index="bindings.taskIndex" :active-task-id="bindings.workbench.activeTask.value?.session.activeTaskId.value ?? null" @open-task="bindings.workbench.openTask" @new-task="bindings.workbench.newTask" />
    </template>
    <div v-show="tasksVisible" class="desktop-workbench-area__tasks">
      <WorkbenchLayoutNode :node="layout.root" />
    </div>
    <RouterView v-if="!tasksVisible" />
    <template #context>
      <div class="desktop-workbench-area__context" data-workbench-context @focusin="focusContext" @pointerdown="focusContext">
        <DesktopTaskResourcePanel :panel="bindings.resources" :context="bindings.resourceContext" :language="language" :visible="(tasksVisible || bindings.contextPanelGlobal.value) && bindings.resources.isOpen.value">
          <template #view="{ viewId }">
            <WorkbenchSurface :view-id="viewId" :visible="(tasksVisible || bindings.contextPanelGlobal.value) && bindings.resources.isOpen.value" />
          </template>
          <template #file-toolbar="{ tab }">
            <div :ref="element => toolbarTarget(tab.id, element)" class="desktop-workbench-area__file-toolbar" />
          </template>
          <template #file="{ wrap, setWrap }">
            <DesktopDirectoryFileSurface v-if="selectedFile" :view="selectedFile" :wrap="wrap" :visible="(tasksVisible || bindings.contextPanelGlobal.value) && bindings.resources.isOpen.value" @update-wrap="setWrap" />
            <div v-else class="desktop-workbench-area__file-loading">
              <NSpin size="small" />{{ labels.loading }}
            </div>
          </template>
        </DesktopTaskResourcePanel>
      </div>
    </template>
  </DesktopWorkbenchLayout>
</template>

<style scoped>
.desktop-workbench-area__context { display: flex; flex: 1; min-width: 0; min-height: 0; }
.desktop-workbench-area__tasks { display: flex; flex: 1; min-width: 0; min-height: 0; }
.desktop-workbench-area__tasks > :deep(*) { flex: 1; }
.desktop-workbench-area__file-toolbar { display: flex; min-width: 0; flex: 1; }
.desktop-workbench-area__file-loading { display: grid; flex: 1; place-content: center; gap: 12px; color: var(--buddy-text-muted); font-size: 12px; }
</style>
