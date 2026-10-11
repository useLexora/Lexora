<script setup lang="ts">
import type { WorkbenchView } from '../common/workbench'
import { useDraggable } from '@dnd-kit/vue'
import { useTemplateRef } from 'vue'

const props = defineProps<{ view: WorkbenchView }>()
const element = useTemplateRef<HTMLElement>('element')
const { isDragging } = useDraggable({ id: () => props.view.id, type: 'workbench-task', element, data: () => ({ resource: props.view.resource, title: props.view.title }) })
</script>

<template>
  <strong ref="element" class="workbench-pane-title block overflow-hidden text-ellipsis whitespace-nowrap cursor-grab select-none" :class="{ 'is-dragging': isDragging }">{{ view.title }}</strong>
</template>

<style scoped lang="scss">
.workbench-pane-title {
  touch-action: none;
  -webkit-user-select: none;
}

.workbench-pane-title:active,
.workbench-pane-title.is-dragging {
  cursor: grabbing;
}
</style>
