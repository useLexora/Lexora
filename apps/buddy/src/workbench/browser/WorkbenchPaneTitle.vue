<script setup lang="ts">
import type { WorkbenchView } from '../common/workbench'
import { useDraggable } from '@dnd-kit/vue'
import { useTemplateRef } from 'vue'

const props = defineProps<{ view: WorkbenchView }>()
const element = useTemplateRef<HTMLElement>('element')
useDraggable({ id: () => props.view.id, type: 'workbench-task', element, data: () => ({ resource: props.view.resource, title: props.view.title }) })
</script>

<template>
  <strong ref="element" class="workbench-pane-title">{{ view.title }}</strong>
</template>

<style scoped>
.workbench-pane-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: grab; touch-action: none; }
</style>
