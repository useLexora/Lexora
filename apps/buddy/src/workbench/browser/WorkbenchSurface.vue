<script setup lang="ts">
import { useTemplateRef, watch } from 'vue'
import { useWorkbench } from './workbenchContext'

const props = withDefaults(defineProps<{ viewId: string, visible?: boolean, preparing?: boolean }>(), { visible: true, preparing: false })
const { mountView, controller } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
watch([element, () => props.viewId, () => props.visible], ([element, id, visible], _, cleanup) => {
  if (element && visible)
    cleanup(mountView(id, element))
})
</script>

<template>
  <div ref="element" class="workbench-surface flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden" :class="{ 'is-preparing': preparing }" :inert="preparing || undefined" :aria-hidden="preparing || undefined" @focusin="controller.focus(viewId)" @pointerdown="controller.focus(viewId)" />
</template>

<style scoped lang="scss">
.workbench-surface.is-preparing { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
</style>
