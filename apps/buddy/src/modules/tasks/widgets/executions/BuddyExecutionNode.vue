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
const labels = computed(() => executionLabels(props.language, props.execution.errorCode))
const identity = useBuddyIdentity(computed(() => props.execution.buddyId))
const root = computed(() => props.execution.kind === 'root')
const actor = computed(() => props.execution.kind !== 'npc_child')
const openable = computed(() => !root.value)
const isStopping = computed(() => props.execution.phase !== 'closed' && (props.stopping || props.execution.stopping))
const phase = computed(() => {
  const status = isStopping.value ? labels.value.stopping : props.execution.waitingFor ? executionStatus(props.execution, props.language, props.now) : executionPhaseLabel(props.execution, props.language, props.now)
  return actor.value && props.execution.cleanup === 'degraded' ? `${status} · ${labels.value.cleanupBadge}` : status
})
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
    :class="[{ 'selected': selected && openable, openable, root, 'buddy-border-beam': busy }, tone]"
    :data-execution-kind="execution.kind"
    :data-execution-id="execution.runId" :data-execution-status="execution.status" :data-execution-phase="execution.phase"
    :data-selected="selected && openable"
  >
    <component :is="openable ? 'button' : 'div'" :type="openable ? 'button' : undefined" :data-testid="openable ? 'execution-node-open' : 'execution-actor-status'" :aria-pressed="openable ? selected : undefined" class="grid w-full min-w-0 gap-1 p-0 border-0 rounded-micro bg-transparent text-left cursor-grab active:cursor-grabbing" :class="{ 'execution-node__open': openable }" @pointerdown="pointerDown" @click="openable && open($event)">
      <span class="flex min-w-0 items-center gap-[6px]">
        <BuddyAvatar :buddy-id="execution.buddyId" :src="identity?.avatar" class="size-5 flex-none" />
        <strong class="flex min-w-0 flex-1 items-center gap-1 text-fg text-[13px] font-600">
          <span v-if="!actor && execution.ordinal !== null" class="flex-none tabular-nums">#{{ execution.ordinal }}</span>
          <span class="truncate">{{ identity?.name ?? execution.buddyName }}</span>
        </strong>
        <span role="status" class="flex-none whitespace-nowrap text-[11px]" :class="tone === 'failed' ? 'text-danger' : tone === 'attention' ? 'text-warning' : 'text-muted'">{{ phase }}</span>
      </span>
      <span v-if="!actor" class="block truncate text-muted text-[12px] leading-[18px]">{{ execution.task || labels.subtasks }}</span>
    </component>
    <div v-if="!actor" class="flex min-w-0 min-h-6 items-center gap-2 text-[11px] leading-[18px]">
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

  &.openable:hover {
    background: var(--buddy-state-hover);
  }
}

.execution-node__open {
  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 2px;
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
