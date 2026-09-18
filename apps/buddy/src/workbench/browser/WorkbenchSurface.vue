<script setup lang="ts">
import { useTemplateRef, watch } from 'vue'
import { useWorkbench } from './workbenchContext'

const props = withDefaults(defineProps<{ viewId: string, visible?: boolean }>(), { visible: true })
const { mountView, controller } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
watch([element, () => props.viewId, () => props.visible], ([element, id, visible], _, cleanup) => {
  if (element && visible)
    cleanup(mountView(id, element))
})
</script>

<template>
  <div ref="element" class="workbench-surface" @focusin="controller.focus(viewId)" @pointerdown="controller.focus(viewId)" />
</template>

<style scoped>
.workbench-surface { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
</style>
