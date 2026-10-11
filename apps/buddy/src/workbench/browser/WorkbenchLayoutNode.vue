<script setup lang="ts">
import type { WorkbenchNode } from '../common/workbench'
import type { WorkbenchSashBoundaries } from './useWorkbenchResize'
import { computed, useTemplateRef, watch } from 'vue'
import { useWorkbench } from './workbenchContext'
import WorkbenchPane from './WorkbenchPane.vue'

const props = withDefaults(defineProps<{ node: WorkbenchNode, boundaries?: WorkbenchSashBoundaries }>(), { boundaries: () => ({}) })
const { resize, labels } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
const splitId = computed(() => props.node.kind === 'split' ? props.node.id : null)
watch([splitId, element], ([id, target], _, cleanup) => {
  if (id && target)
    cleanup(resize.register(id, target, () => props.node))
})
const horizontal = computed(() => props.node.kind === 'split' && props.node.axis === 'horizontal')
const firstBoundaries = computed(() => ({ ...props.boundaries, [horizontal.value ? 'right' : 'bottom']: props.node.id }))
const secondBoundaries = computed(() => ({ ...props.boundaries, [horizontal.value ? 'left' : 'top']: props.node.id }))
const junctions = computed(() => [
  { edge: 'start', id: props.boundaries[horizontal.value ? 'top' : 'left'] },
  { edge: 'end', id: props.boundaries[horizontal.value ? 'bottom' : 'right'] },
].filter((item): item is { edge: string, id: string } => !!item.id))
</script>

<template>
  <WorkbenchPane v-if="node.kind === 'pane'" :pane="node" />
  <div v-else ref="element" class="workbench-split relative grid min-w-0 min-h-0 h-full" :class="node.axis" :data-split-id="node.id" :style="horizontal ? { gridTemplateColumns: `minmax(0, ${node.ratio}fr) 1px minmax(0, ${1 - node.ratio}fr)` } : { gridTemplateRows: `minmax(0, ${node.ratio}fr) 1px minmax(0, ${1 - node.ratio}fr)` }">
    <WorkbenchLayoutNode :node="node.first" :boundaries="firstBoundaries" />
    <div
      class="workbench-split__handle relative bg-border outline-none" :class="{ 'is-highlighted': resize.highlighted(node.id) }" role="separator" tabindex="0"
      :aria-label="labels.resize" :aria-orientation="horizontal ? 'vertical' : 'horizontal'" :aria-valuenow="Math.round(node.ratio * 100)" aria-valuemin="15" aria-valuemax="85"
      @pointerdown="resize.begin([node.id], $event)" @pointerover.stop="resize.hover([node.id])" @pointerleave="resize.hover([])"
      @dblclick.stop="resize.reset([node.id])" @keydown="resize.keyboard([node.id], $event)"
    >
      <button
        v-for="junction in junctions" :key="junction.edge" class="workbench-split__junction absolute z-21 w-[12px] h-[12px] p-0 border-0 bg-transparent focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus" :class="junction.edge" type="button" :aria-label="labels.resizeBoth"
        @pointerdown.stop="resize.begin([node.id, junction.id], $event)" @pointerover.stop="resize.hover([node.id, junction.id])" @pointerleave="resize.hover([node.id])"
        @dblclick.stop="resize.reset([node.id, junction.id])" @keydown.stop="resize.keyboard([node.id, junction.id], $event)"
      />
    </div>
    <WorkbenchLayoutNode :node="node.second" :boundaries="secondBoundaries" />
  </div>
</template>

<style scoped lang="scss">
.workbench-split__handle { touch-action: none; }
.workbench-split__handle::before { position: absolute; z-index: 20; content: ''; inset: 0; }
.workbench-split__handle::after { position: absolute; z-index: 20; content: ''; inset: 0; pointer-events: none; transition: background-color 100ms ease-out; }
.horizontal > .workbench-split__handle { cursor: col-resize; }
.horizontal > .workbench-split__handle::before { left: -4px; right: -4px; }
.horizontal > .workbench-split__handle::after { left: -1.5px; right: -1.5px; }
.vertical > .workbench-split__handle { cursor: row-resize; }
.vertical > .workbench-split__handle::before { top: -4px; bottom: -4px; }
.vertical > .workbench-split__handle::after { top: -1.5px; bottom: -1.5px; }
.workbench-split__handle.is-highlighted::after, .workbench-split__handle:focus-visible::after { background: var(--buddy-accent-solid); }
.workbench-split__junction { cursor: all-scroll; touch-action: none; }
.horizontal > .workbench-split__handle > .workbench-split__junction { left: -5.5px; }
.horizontal > .workbench-split__handle > .start { top: -6px; }
.horizontal > .workbench-split__handle > .end { bottom: -6px; }
.vertical > .workbench-split__handle > .workbench-split__junction { top: -5.5px; }
.vertical > .workbench-split__handle > .start { left: -6px; }
.vertical > .workbench-split__handle > .end { right: -6px; }
@media (prefers-reduced-motion: reduce) { .workbench-split__handle::after { transition: none; } }
</style>
