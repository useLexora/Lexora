<script setup lang="ts">
import type { WorkbenchView } from '@/workbench/common/workbench'
import { watch } from 'vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import WorkbenchSurface from '@/workbench/browser/WorkbenchSurface.vue'

const props = defineProps<{ view: WorkbenchView, wrap: boolean, visible: boolean }>()
const emit = defineEmits<{ updateWrap: [value: boolean] }>()
const { controller } = useWorkbench()
watch([() => props.view.id, () => props.wrap], () => {
  if (props.view.state.wrap !== props.wrap)
    controller.updateView(props.view.id, { state: { ...props.view.state, wrap: props.wrap } })
}, { immediate: true })
watch(() => props.view.state.wrap, (value) => {
  if (typeof value === 'boolean' && value !== props.wrap)
    emit('updateWrap', value)
})
</script>

<template>
  <WorkbenchSurface :view-id="view.id" :visible="visible" />
</template>
