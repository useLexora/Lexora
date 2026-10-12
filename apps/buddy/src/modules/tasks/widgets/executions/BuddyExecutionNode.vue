<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyIdentity } from '@/modules/buddies'
import { BuddyAvatar } from '@/modules/buddies/ui'
import { executionNeedsAttention } from '../../model/executions/executionCanvas'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import { executionLabels } from './executionLabels'
import { executionPhaseLabel, executionStatus } from './executionPresentation'

const props = defineProps<{ execution: LocalExecution, language: BuddyLocale, now: number, selected: boolean, stopping: boolean, failed: boolean, enabled: boolean }>()
const emit = defineEmits<{ open: [], stop: [] }>()
const labels = computed(() => executionLabels(props.language))
const identity = useBuddyIdentity(computed(() => props.execution.buddyId))
const root = computed(() => props.execution.kind === 'root')
const isStopping = computed(() => props.execution.phase !== 'closed' && (props.stopping || props.execution.stopping))
const phase = computed(() => isStopping.value ? labels.value.stopping : props.execution.waitingFor && !root.value ? executionStatus(props.execution, props.language, props.now) : executionPhaseLabel(props.execution, props.language, props.now))
const action = computed(() => executionStatus(props.execution, props.language, props.now))
const tools = computed(() => labels.value.toolCount.replace('{count}', new Intl.NumberFormat(props.language, { notation: 'compact', maximumFractionDigits: 1 }).format(props.execution.toolCount)))
const active = computed(() => props.execution.status === 'running' && (props.execution.phase === 'preparing' || props.execution.phase === 'working') && !props.execution.waitingFor && !isStopping.value)
const busy = computed(() => active.value && !props.execution.progress?.retry)
const duration = computed(() => formatChatRunDuration(props.execution.startedAt, props.execution.completedAt, props.now))
const cancellable = computed(() => !root.value && props.execution.canCancel)
const tone = computed(() => props.execution.status === 'failed' ? 'failed' : executionNeedsAttention(props.execution) || props.execution.cleanup === 'degraded' ? 'attention' : props.execution.phase === 'closed' ? 'finished' : 'active')
let pointerStart: { x: number, y: number } | null = null
function pointerDown(event: PointerEvent) {
  pointerStart = { x: event.clientX, y: event.clientY }
}
function open(event: MouseEvent) {
  const start = pointerStart
  pointerStart = null
  if (event.detail && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)
    return
  emit('open')
}
</script>

<template>
  <article
    class="execution-node relative grid h-full w-full min-w-0 content-center gap-1 p-[10px] border-1 border-solid border-border rounded-micro bg-raised select-none"
    :class="[{ selected, root, 'buddy-border-beam': busy }, tone]"
    :data-execution-id="execution.runId" :data-execution-status="execution.status" :data-execution-phase="execution.phase"
    :data-selected="selected"
  >
    <button type="button" data-testid="execution-node-open" :aria-pressed="selected" class="execution-node__open grid w-full min-w-0 gap-1 p-0 border-0 rounded-micro bg-transparent text-left cursor-grab active:cursor-grabbing" @pointerdown="pointerDown" @click="open">
      <span class="flex min-w-0 items-center gap-[6px]">
        <BuddyAvatar :buddy-id="execution.buddyId" :src="identity?.avatar" class="size-5 flex-none" />
        <strong class="flex min-w-0 flex-1 items-center gap-1 text-fg text-[13px] font-600">
          <span v-if="execution.ordinal !== null" class="flex-none tabular-nums">#{{ execution.ordinal }}</span>
          <span class="truncate">{{ identity?.name ?? execution.buddyName }}</span>
        </strong>
        <span role="status" class="flex-none whitespace-nowrap text-[11px]" :class="tone === 'failed' ? 'text-danger' : tone === 'attention' ? 'text-warning' : 'text-muted'">{{ phase }}</span>
      </span>
      <span class="block truncate text-muted text-[12px] leading-[18px]">{{ root ? execution.waitingFor ? action : labels.mainTask : execution.task || labels.subtasks }}</span>
    </button>
    <div class="flex min-w-0 min-h-6 items-center gap-2 text-[11px] leading-[18px]">
      <span v-if="failed" role="alert" class="min-w-0 flex-1 truncate text-danger">{{ labels.actionFailed }}</span>
      <span v-else-if="execution.cleanup === 'degraded'" role="alert" class="min-w-0 flex-1 truncate text-warning">{{ labels.cleanupBadge }}</span>
      <template v-else>
        <span class="flex-none text-muted tabular-nums">{{ tools }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ active && action !== phase ? action : '' }}</span>
      </template>
      <span class="flex-none tabular-nums text-muted" aria-live="off">{{ duration }}</span>
      <button v-if="cancellable" type="button" class="execution-node__stop relative flex-none h-6 border-0 rounded-micro bg-transparent text-muted text-[11px] leading-[18px] px-1 py-0 cursor-pointer" :disabled="!enabled || isStopping" @pointerdown.stop @mousedown.stop @click.stop="emit('stop')">
        {{ isStopping ? labels.stopping : labels.stop }}
      </button>
    </div>
  </article>
</template>

<style scoped lang="scss">
.execution-node {
  &.attention {
    border-color: var(--buddy-status-warning-border);
  }

  &.failed {
    border-color: var(--buddy-status-danger-border);
  }

  &.selected {
    border-color: var(--buddy-accent-border);
    box-shadow: inset 0 0 0 1px var(--buddy-accent-border);
  }

  &.root {
    background: var(--buddy-surface-subtle);
  }
}

.execution-node__open {
  &::after {
    position: absolute;
    inset: 0;
    border-radius: var(--buddy-radius-micro);
    content: '';
  }

  &:hover::after {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: none;
  }

  &:focus-visible::after {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -3px;
  }
}

.execution-node__stop {
  &:enabled:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-status-danger-text);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
  }

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}
</style>
