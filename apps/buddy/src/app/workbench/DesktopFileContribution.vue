<script setup lang="ts">
import type { WorkbenchView } from '@/workbench/common/workbench'
import { computed } from 'vue'
import { DesktopFileEditor, DesktopFilePreview } from '@/modules/files/ui'
import { useTaskEnvironment } from '@/modules/tasks'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const workbench = useDesktopWorkbenchContext()
const { layout } = useWorkbench()
const retainsPreview = computed(() => Object.values(layout.value.views).some(view => view.state.inlineOwner === props.view.id))
const { clipboard } = useTaskEnvironment()
const toolbarTarget = computed(() => typeof props.view.state.contextTabId === 'string' ? workbench.fileToolbarTargets.get(props.view.state.contextTabId) : null)
</script>

<template>
  <template v-if="visible || retainsPreview || typeof view.state.contextTabId !== 'string'">
    <DesktopFilePreview v-if="view.type === 'files.preview'" :view="view" :files="workbench.api.localChat.spaces" :language="workbench.language.value" :write-clipboard-text="clipboard.writeText" :toolbar-target="toolbarTarget" :visible="visible" />
    <DesktopFileEditor v-else :view="view" :models="workbench.models" :language="workbench.language.value" :write-clipboard-text="clipboard.writeText" :toolbar-target="toolbarTarget" :visible="visible" />
  </template>
</template>
