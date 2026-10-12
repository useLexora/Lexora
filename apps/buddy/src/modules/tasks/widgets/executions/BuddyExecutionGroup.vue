<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { computed, defineAsyncComponent, onScopeDispose, shallowReactive, shallowRef, useTemplateRef } from 'vue'
import { executionNeedsAttention, projectExecutionCanvas } from '../../model/executions/executionCanvas'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import { executionLabels } from './executionLabels'

const props = defineProps<{ rootRunId: string, language: BuddyLocale }>()
const BuddyExecutionCanvas = defineAsyncComponent(() => import('./BuddyExecutionCanvas.vue'))
const canvas = useTemplateRef<{ focus: (id: string) => void }>('canvas')
const tree = useExecutionTree()
const labels = computed(() => executionLabels(props.language))
const nodes = computed(() => projectExecutionCanvas(tree?.records.value ?? [], props.rootRunId))
const root = computed(() => nodes.value[0]?.execution)
const children = computed(() => nodes.value.slice(1).map(node => node.execution))
const visible = computed(() => children.value.length > 0 || (!!root.value && (root.value.questions.length > 0 || root.value.cleanup === 'degraded')))
const unfinished = computed(() => children.value.filter(child => child.phase !== 'closed').length)
const attention = computed(() => nodes.value.filter(node => executionNeedsAttention(node.execution)))
const canStopAll = computed(() => root.value?.canCancel && children.value.some(child => child.canCancel))
const stoppingAll = shallowRef(false)
const failedAll = shallowRef(false)
const stopping = shallowReactive(new Set<string>())
const failed = shallowReactive(new Set<string>())
let disposed = false
onScopeDispose(() => disposed = true)

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
  if (next) {
    canvas.value?.focus(next.execution.runId)
    void open(next.execution.runId)
  }
}
</script>

<template>
  <div v-if="visible" class="grid gap-2 pb-[var(--buddy-chat-gap-block)]" data-testid="execution-tree">
    <header class="flex flex-wrap items-center justify-between gap-2 text-muted text-[12px]">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="flex items-center gap-1 font-600">
          {{ children.length ? labels.subtasks : labels.mainTask }}
          <span v-if="children.length" class="px-1 rounded-micro bg-subtle font-normal tabular-nums">{{ children.length }}</span>
        </strong>
        <span v-if="children.length && unfinished < children.length">· {{ unfinished ? labels.unfinishedCount.replace('{count}', String(unfinished)) : labels.allFinished }}</span>
        <NButton v-if="attention.length" quaternary size="tiny" type="warning" @click="focusAttention">
          {{ labels.needsYouCount.replace('{count}', String(attention.length)) }}
        </NButton>
      </div>
      <NButton v-if="canStopAll" quaternary size="tiny" :loading="stoppingAll" :disabled="!tree?.ready.value" @click="stopAll">
        {{ stoppingAll ? labels.stopping : labels.stopAll }}
      </NButton>
    </header>
    <p v-if="failedAll" role="alert" class="m-0 text-danger text-[12px]">
      {{ labels.actionFailed }}
    </p>
    <BuddyExecutionCanvas
      ref="canvas" :nodes="nodes" :language="language" :selected-run-id="tree?.selectedRunId.value ?? null"
      :stopping="stopping" :failed="failed" :enabled="!!tree?.ready.value && !stoppingAll"
      @open="open" @stop="stop"
    />
  </div>
</template>
