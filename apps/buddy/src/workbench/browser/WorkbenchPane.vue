<script setup lang="ts">
import type { WorkbenchPane } from '../common/workbench'
import { useDragDropMonitor, useDroppable } from '@dnd-kit/vue'
import { computed, useTemplateRef } from 'vue'
import WorkbenchSlot from '@/shared/ui/contributions/WorkbenchSlot.vue'
import { useProvideWorkbenchUiScope, useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { panes } from '../common/workbench'
import { resolveWorkbenchDrop } from '../common/workbenchDrop'
import WorkbenchMountPoint from './mounts/WorkbenchMountPoint.vue'
import { useWorkbench } from './workbenchContext'
import WorkbenchNavigationStatus from './WorkbenchNavigationStatus.vue'
import WorkbenchSurface from './WorkbenchSurface.vue'

const props = defineProps<{ pane: WorkbenchPane }>()
useProvideWorkbenchUiScope({ instanceId: () => props.pane.id })
const { controller, layout, revision, labels, dropPosition } = useWorkbench()
const pending = computed(() => {
  void revision.value
  return controller.navigation.entries.get(props.pane.id)
})
const viewIds = computed(() => [props.pane.view, pending.value?.status === 'loading' ? pending.value.view.id : null].filter((id): id is string => !!id))
const focused = computed(() => layout.value.activePane === props.pane.id && panes(layout.value.root).length > 1)
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
  <section ref="element" class="workbench-pane" :class="{ 'is-focused': focused }" :data-pane-id="pane.id" tabindex="-1" @focusin="controller.activate(pane.id)" @pointerdown="controller.activate(pane.id)">
    <WorkbenchMountPoint target="workbench.pane" :instance-id="pane.id">
      <WorkbenchSurface v-for="id in viewIds" :key="id" :view-id="id" :preparing="id !== pane.view" />
      <WorkbenchSlot v-if="!pane.view" target="workbench.pane.empty" class="workbench-pane__empty-slot">
        <div class="workbench-pane__empty">
          <p>{{ labels.empty }}</p>
          <button type="button" @click="controller.registry.execute('task.new', controller.context)">
            {{ labels.newTask }}
          </button>
        </div>
      </WorkbenchSlot>
    </WorkbenchMountPoint>
    <WorkbenchNavigationStatus v-if="pending" :key="pending.view.id" :entry="pending" />
    <div v-if="drop" class="workbench-pane__drop" :class="drop" :data-drop-position="drop" />
  </section>
</template>

<style scoped>
.workbench-pane { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--buddy-surface-canvas); }
.workbench-pane.is-focused { box-shadow: inset 0 2px var(--buddy-accent-solid); }
.workbench-pane__empty { margin: auto; padding: 24px; text-align: center; font-size: 12px; color: var(--buddy-text-secondary); }
.workbench-pane__empty-slot { width: 100%; margin: auto; }
.workbench-pane__empty button { background: var(--buddy-state-hover); color: var(--buddy-text-primary); border: 1px solid var(--buddy-border-subtle); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.workbench-pane__drop { position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--buddy-accent-solid) 16%, transparent); border: 2px solid var(--buddy-accent-solid); pointer-events: none; }
.workbench-pane__drop.left { right: 50%; }
.workbench-pane__drop.right { left: 50%; }
.workbench-pane__drop.up { bottom: 50%; }
.workbench-pane__drop.down { top: 50%; }
</style>
