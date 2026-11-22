<script setup lang="ts">
import type { AnnotatedImageQuote } from '@/shared/ui/files/imageAnnotation'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { computed } from 'vue'
import { DesktopFileEditor, DesktopFilePreview } from '@/modules/files/ui'
import { useTaskEnvironment } from '@/modules/tasks'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'
import { receiveReferenceMaterial } from './receiveReferenceMaterial'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const workbench = useDesktopWorkbenchContext()
const { layout } = useWorkbench()
const retainsPreview = computed(() => Object.values(layout.value.views).some(view => view.state.inlineOwner === props.view.id))
const { clipboard } = useTaskEnvironment()
const toolbarTarget = computed(() => typeof props.view.state.contextTabId === 'string' ? workbench.fileToolbarTargets.get(props.view.state.contextTabId) : null)
function quoteSnapshot(input: AnnotatedImageQuote) {
  return receiveReferenceMaterial({
    references: workbench.selectionReferences,
    controller: workbench.controller,
    pool: workbench.pool,
    scope: input.scope,
    targetId: input.targetId,
    material: { kind: 'file', name: input.name, mimeType: 'image/png', base64: input.base64 },
    current: input.current,
  })
}
</script>

<template>
  <template v-if="visible || retainsPreview || typeof view.state.contextTabId !== 'string'">
    <DesktopFilePreview v-if="view.type === 'files.preview'" :view="view" :files="workbench.api.localChat.spaces" :task-files="workbench.api.localChat.taskFiles" :language="workbench.language.value" :write-clipboard-text="clipboard.writeText" :toolbar-target="toolbarTarget" :visible="visible" :quote-snapshot="quoteSnapshot" />
    <DesktopFileEditor v-else :view="view" :models="workbench.models" :editors="workbench.editors" :language="workbench.language.value" :write-clipboard-text="clipboard.writeText" :toolbar-target="toolbarTarget" :visible="visible" />
  </template>
</template>
