<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed, defineAsyncComponent, onScopeDispose, shallowReactive, shallowRef, useId, useTemplateRef, watch } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { executionNeedsAttention, projectExecutionCanvas } from '../../model/executions/executionCanvas'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import { executionLabels } from './executionLabels'

const props = defineProps<{ rootRunId: string, language: BuddyLocale }>()
const BuddyExecutionCanvas = defineAsyncComponent(() => import('./BuddyExecutionCanvas.vue'))
const canvas = useTemplateRef<{ focus: (id: string) => void }>('canvas')
const canvasId = useId()
const tree = useExecutionTree()
const group = computed(() => tree?.groups.value.byRoot.get(props.rootRunId))
const nodes = computed(() => projectExecutionCanvas(group.value?.records ?? [], props.rootRunId))
const root = computed(() => group.value?.root)
const labels = computed(() => executionLabels(props.language, root.value?.errorCode))
const children = computed(() => nodes.value.slice(1).map(node => node.execution))
const collaborating = computed(() => group.value?.mode === 'collaboration')
const npcCount = computed(() => group.value?.subtasks.length ?? 0)
const visible = computed(() => children.value.length > 0 || (!!root.value && (root.value.questions.length > 0 || root.value.cleanup === 'degraded')))
const unfinished = computed(() => children.value.filter(child => child.phase !== 'closed').length)
const attention = computed(() => nodes.value.filter(node => node.execution.kind === 'npc_child' && executionNeedsAttention(node.execution)))
const issues = computed(() => children.value.filter(child => child.status === 'failed' || child.cleanup === 'degraded'))
const canStopAll = computed(() => !collaborating.value && root.value?.canCancel && children.value.some(child => child.canCancel))
const expanded = shallowRef<boolean | null>(null)
const canvasLoaded = shallowRef(false)
const attentionTarget = shallowRef<string | null>(null)
const stoppingAll = shallowRef(false)
const failedAll = shallowRef(false)
const stopping = shallowReactive(new Set<string>())
const failed = shallowReactive(new Set<string>())
let disposed = false
onScopeDispose(() => disposed = true)
watch(visible, (shown) => {
  if (shown && expanded.value === null)
    expanded.value = root.value?.phase !== 'closed'
}, { immediate: true })
watch(expanded, (shown) => {
  if (shown)
    canvasLoaded.value = true
}, { immediate: true })
watch([canvas, attentionTarget], ([value, id]) => {
  if (value && id) {
    value.focus(id)
    attentionTarget.value = null
  }
}, { flush: 'post' })

async function stopAll() {
  if (!root.value || !canStopAll.value || !tree?.api || !tree.ready.value || stoppingAll.value)
    return
  stoppingAll.value = true
  failedAll.value = false
  const pending = children.value.filter(child => child.canCancel && !stopping.has(child.runId)).map(child => child.runId)
  pending.forEach(runId => stopping.add(runId))
  try {
    await tree.api.cancelChildren(tree.target(root.value))
    if (!disposed)
      await tree.refresh()
  }
  catch {
    if (!disposed)
      failedAll.value = true
  }
  finally {
    stoppingAll.value = false
    pending.forEach(runId => stopping.delete(runId))
  }
}

async function stop(runId: string) {
  const record = nodes.value.find(node => node.execution.runId === runId)?.execution
  if (!record?.canCancel || !tree?.api || !tree.ready.value || stopping.has(runId) || stoppingAll.value)
    return
  stopping.add(runId)
  failed.delete(runId)
  try {
    await tree.api.cancel(tree.target(record))
    if (!disposed)
      await tree.refresh()
  }
  catch {
    if (!disposed)
      failed.add(runId)
  }
  finally {
    stopping.delete(runId)
  }
}

async function open(runId: string) {
  const record = nodes.value.find(node => node.execution.runId === runId)?.execution
  if (record) {
    if (record.kind === 'root' || record.kind === 'maintenance') {
      return
    }
    try {
      await tree?.open(record)
    }
    catch (error) {
      tree?.onError?.(error)
    }
  }
}

function focusAttention() {
  const next = attention.value.find(node => node.execution.runId !== tree?.selectedRunId.value) ?? attention.value[0]
  if (next)
    reveal(next.execution.runId)
}

function focusIssue() {
  const next = issues.value.find(child => child.runId !== tree?.selectedRunId.value) ?? issues.value[0]
  if (next)
    reveal(next.runId)
}

function reveal(runId: string) {
  expanded.value = true
  attentionTarget.value = runId
  void open(runId)
}
</script>

<template>
  <div v-if="visible" class="buddy-chat-execution-group grid gap-2 pb-[var(--buddy-chat-gap-section)]" data-testid="execution-tree">
    <header class="flex flex-wrap min-w-0 items-center justify-between gap-2 text-muted text-[12px]">
      <div class="flex min-w-0 max-w-full items-center gap-2">
        <button type="button" class="buddy-chat-activity-row" :aria-expanded="expanded === true" :aria-controls="canvasLoaded ? canvasId : undefined" data-testid="execution-canvas-toggle" @click="expanded = !expanded">
          <span class="buddy-chat-activity-row__label">
            <strong class="font-600">{{ collaborating ? labels.collaboration : children.length ? labels.subtasks : labels.mainTask }}</strong>{{ ' ' }}
            <span v-if="children.length && !collaborating" class="px-1 rounded-micro bg-subtle tabular-nums">{{ children.length }}</span>
            <span v-if="collaborating"> {{ labels.participants.replace('{count}', String(group?.participantCount ?? 0)) }}</span>
            <span v-if="collaborating && npcCount"> · {{ labels.subtasks }} {{ npcCount }}</span>
            <span v-if="children.length && (unfinished || root?.phase === 'closed')"> · {{ unfinished ? labels.unfinishedCount.replace('{count}', String(unfinished)) : labels.allFinished }}</span>
          </span>
          <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': expanded }" aria-hidden="true" />
        </button>
        <NButton v-if="issues.length" class="flex-none" quaternary size="tiny" type="warning" @click="focusIssue">
          {{ labels.issuesCount.replace('{count}', String(issues.length)) }}
        </NButton>
        <NButton v-if="attention.length" class="flex-none" quaternary size="tiny" type="warning" @click="focusAttention">
          {{ labels.needsYouCount.replace('{count}', String(attention.length)) }}
        </NButton>
      </div>
      <NButton v-if="canStopAll" class="flex-none" quaternary size="tiny" :loading="stoppingAll" :disabled="!tree?.ready.value" @click="stopAll">
        {{ stoppingAll ? labels.stopping : collaborating ? labels.stopParticipants : labels.stopAll }}
      </NButton>
    </header>
    <p v-if="failedAll" role="alert" class="m-0 text-danger text-[12px]">
      {{ labels.actionFailed }}
    </p>
    <BuddyExecutionCanvas
      v-if="canvasLoaded" v-show="expanded"
      :id="canvasId"
      ref="canvas" :nodes="nodes" :language="language" :selected-run-id="tree?.selectedRunId.value ?? null"
      :stopping="stopping" :failed="failed" :enabled="!!tree?.ready.value && !stoppingAll"
      @open="open" @stop="stop"
    />
    <p v-if="root?.cleanup === 'degraded'" class="m-0 text-warning text-[12px]" role="alert">
      {{ labels.cleanup }}
    </p>
  </div>
</template>

<style scoped lang="scss">
@use '../transcript/chatActivityRow' as activity;

@include activity.header;
</style>
