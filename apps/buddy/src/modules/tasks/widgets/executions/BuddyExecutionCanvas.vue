<script setup lang="ts">
import type { ExecutionCanvasNode } from '../../model/executions/executionCanvas'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Add20Regular, FullScreenMaximize20Regular, Grid20Regular, Subtract20Regular } from '@vicons/fluent'
import { useIntervalFn } from '@vueuse/core'
import { NTooltip } from 'naive-ui'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyExecutionNode from './BuddyExecutionNode.vue'
import { executionLabels } from './executionLabels'
import { useExecutionCanvas } from './useExecutionCanvas'

const props = defineProps<{ nodes: readonly ExecutionCanvasNode[], language: BuddyLocale, selectedRunId: string | null, stopping: ReadonlySet<string>, failed: ReadonlySet<string>, enabled: boolean }>()
const emit = defineEmits<{ open: [runId: string], stop: [runId: string] }>()
const container = useTemplateRef<HTMLElement>('container')
const surface = useTemplateRef<HTMLElement>('surface')
const nodes = computed(() => props.nodes)
const records = computed(() => new Map(props.nodes.map(node => [node.execution.runId, node.execution])))
const labels = computed(() => executionLabels(props.language))
const height = computed(() => Math.max(180, Math.min(420, Math.max(...props.nodes.map(node => node.y + node.height), 0) + 32)))
const canvas = useExecutionCanvas(container, surface, nodes)
const now = shallowRef(Date.now())
const clock = useIntervalFn(() => now.value = Date.now(), 1000, { immediate: false })
watch(() => canvas.active.value && props.nodes.some(node => node.execution.phase !== 'closed'), (active) => {
  if (active) {
    now.value = Date.now()
    clock.resume()
  }
  else {
    clock.pause()
  }
}, { immediate: true })
defineExpose({ focus: canvas.focus })
</script>

<template>
  <section class="execution-canvas min-w-0 overflow-hidden border-1 border-solid border-border rounded-micro bg-surface" data-testid="execution-canvas">
    <div ref="surface" class="relative w-full overflow-hidden" :style="{ height: `${height}px` }">
      <div ref="container" class="absolute inset-0" :data-zoom="canvas.zoom.value" data-testid="execution-canvas-graph" />
    </div>
    <Teleport v-for="[id, host] in canvas.hosts" :key="id" :to="host.container">
      <BuddyExecutionNode
        v-if="records.has(host.node.id)" :execution="records.get(host.node.id)!" :language="language" :now="now"
        :selected="selectedRunId === host.node.id" :stopping="stopping.has(host.node.id)" :failed="failed.has(host.node.id)" :enabled="enabled"
        @open="emit('open', host.node.id)" @stop="emit('stop', host.node.id)"
      />
    </Teleport>
    <footer class="flex items-center justify-between gap-2 min-w-0 px-2 py-1 border-t-1 border-t-solid border-t-border text-muted">
      <span class="truncate text-[11px]">{{ labels.canvasHint }}</span>
      <div class="flex flex-none items-center gap-1">
        <NTooltip>
          <template #trigger>
            <button type="button" class="execution-canvas__control" :aria-label="labels.arrange" @click="canvas.arrange">
              <DesktopIcon :component="Grid20Regular" />
            </button>
          </template>
          {{ labels.arrange }}
        </NTooltip>
        <NTooltip>
          <template #trigger>
            <button type="button" class="execution-canvas__control" :aria-label="labels.zoomOut" @click="canvas.zoomBy(-0.1)">
              <DesktopIcon :component="Subtract20Regular" />
            </button>
          </template>
          {{ labels.zoomOut }}
        </NTooltip>
        <span class="w-9 text-center tabular-nums text-[11px]">{{ canvas.zoom.value }}%</span>
        <NTooltip>
          <template #trigger>
            <button type="button" class="execution-canvas__control" :aria-label="labels.zoomIn" @click="canvas.zoomBy(0.1)">
              <DesktopIcon :component="Add20Regular" />
            </button>
          </template>
          {{ labels.zoomIn }}
        </NTooltip>
        <NTooltip>
          <template #trigger>
            <button type="button" class="execution-canvas__control" :aria-label="labels.fit" @click="canvas.fit">
              <DesktopIcon :component="FullScreenMaximize20Regular" />
            </button>
          </template>
          {{ labels.fit }}
        </NTooltip>
      </div>
    </footer>
  </section>
</template>

<style scoped lang="scss">
.execution-canvas__control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  color: inherit;
  background: transparent;
  cursor: pointer;

  &:hover {
    background: var(--buddy-state-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
  }
}
</style>
