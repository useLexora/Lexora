<script setup lang="ts">
import type { WorkbenchPane } from '../common/workbench'
import { useDragDropMonitor, useDroppable } from '@dnd-kit/vue'
import { computed, useTemplateRef } from 'vue'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { resolveWorkbenchDrop } from '../common/workbenchDrop'
import { useWorkbench } from './workbenchContext'
import WorkbenchSurface from './WorkbenchSurface.vue'

const props = defineProps<{ pane: WorkbenchPane }>()
const { controller, layout, labels, dropPosition } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
useWorkbenchAnchor('workbench.pane', () => element.value)
useDroppable({ id: () => `pane:${props.pane.id}`, accept: 'workbench-task', element, data: () => ({ paneId: props.pane.id }) })
useDragDropMonitor({
  onDragMove(event) {
    if (!element.value || event.operation.source?.type !== 'workbench-task')
      return
    const position = resolveWorkbenchDrop(event.to ?? event.operation.position.current, element.value.getBoundingClientRect())
    if (position)
      dropPosition.value = { paneId: props.pane.id, position }
    else if (dropPosition.value?.paneId === props.pane.id)
      dropPosition.value = null
  },
})
const drop = computed(() => dropPosition.value?.paneId === props.pane.id ? dropPosition.value.position : null)
</script>

<template>
  <section ref="element" class="workbench-pane" :class="{ 'is-focused': layout.activePane === pane.id }" :data-pane-id="pane.id" tabindex="-1" @focusin="controller.activate(pane.id)" @pointerdown="controller.activate(pane.id)">
    <WorkbenchSurface v-if="pane.view" :view-id="pane.view" />
    <div v-else class="workbench-pane__empty">
      <p>{{ labels.empty }}</p>
      <button type="button" @click="controller.registry.execute('task.new', controller.context)">
        {{ labels.newTask }}
      </button>
    </div>
    <div v-if="drop" class="workbench-pane__drop" :class="drop" :data-drop-position="drop" />
  </section>
</template>

<style scoped>
.workbench-pane { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--buddy-surface-canvas); }
.workbench-pane.is-focused { box-shadow: inset 0 2px var(--buddy-accent-solid); }
.workbench-pane__empty { margin: auto; padding: 24px; text-align: center; font-size: 12px; color: var(--buddy-text-secondary); }
.workbench-pane__empty button { background: var(--buddy-state-hover); color: var(--buddy-text-primary); border: 1px solid var(--buddy-border-subtle); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.workbench-pane__drop { position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--buddy-accent-solid) 16%, transparent); border: 2px solid var(--buddy-accent-solid); pointer-events: none; }
.workbench-pane__drop.left { right: 50%; }
.workbench-pane__drop.right { left: 50%; }
.workbench-pane__drop.up { bottom: 50%; }
.workbench-pane__drop.down { top: 50%; }
</style>
