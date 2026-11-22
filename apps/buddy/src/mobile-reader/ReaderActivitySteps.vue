<script setup lang="ts">
import type { ReaderSend, ReaderWireEntry } from './readerProtocol'
import { ChevronRight20Regular } from '@vicons/fluent'
import { watch } from 'vue'
import { useChatTranscriptValue } from '../modules/tasks/reader'
import ReaderLiveStepDetail from './ReaderLiveStepDetail.vue'
import ReaderProgress from './ReaderProgress.vue'
import { useReaderStrings } from './readerStrings'

type StepPage = NonNullable<ReaderWireEntry['steps']>
const props = defineProps<{ runId: string, groupId: string, steps?: StepPage, send: ReaderSend }>()
const labels = useReaderStrings()
const statuses = { running: 'running', interrupted: 'stopped', failed: 'failed', completed: 'done' } as const
const expanded = useChatTranscriptValue('activity:expanded-steps', new Set<string>())
function load(cursor?: string | null) {
  if (!props.steps?.loading)
    props.send({ action: 'activity-steps', runId: props.runId, groupId: props.groupId, ...(cursor ? { cursor } : {}) })
}
watch(() => props.steps, (steps, previous) => {
  if (!steps) {
    load()
  }
  else if (previous && expanded.value.size) {
    const waiting = new Set(previous.items.filter(step => !step.messageId).map(step => step.id))
    for (const step of steps.items) {
      if (step.messageId && waiting.has(step.id) && expanded.value.has(step.id) && !step.detail)
        props.send({ action: 'detail', id: step.messageId })
    }
  }
}, { immediate: true })
function toggle(step: StepPage['items'][number]) {
  const next = new Set(expanded.value)
  if (!next.delete(step.id)) {
    next.add(step.id)
    if (step.messageId && !step.detail)
      props.send({ action: 'detail', id: step.messageId })
  }
  expanded.value = next
}
</script>

<template>
  <div class="activity-steps">
    <article v-for="step in steps?.items" :key="step.id" class="reader-tool" :class="{ expanded: expanded.has(step.id), failed: step.status === 'failed' }" :data-step-id="step.id">
      <button type="button" class="tool-call-header" :aria-expanded="expanded.has(step.id)" @click="toggle(step)">
        <span class="tool-call-heading tool-call-title">{{ step.toolName }}</span>
        <span class="tool-call-status">{{ labels[statuses[step.status]] }}</span>
        <ChevronRight20Regular class="reader-icon tool-call-chevron" aria-hidden="true" />
      </button>
      <ReaderLiveStepDetail v-if="!step.messageId && expanded.has(step.id)" :run-id="runId" :group-id="groupId" :step-id="step.id" :send="send" />
      <div v-if="step.messageId && expanded.has(step.id)" class="tool-call-detail">
        <pre v-if="step.detail?.text" class="tool-output">{{ step.detail.text }}</pre>
        <ReaderProgress v-if="!step.detail || step.detail.loading" :label="labels.loadingOutput" />
        <p v-else-if="step.detail?.error" class="message-error">
          {{ step.detail.error }}
        </p>
        <p v-else-if="step.detail?.text === '' && !step.detail.resourceId" class="message-meta">
          {{ labels.noOutput }}
        </p>
        <p v-if="step.detail?.notice" class="message-meta">
          {{ step.detail.notice }}
        </p>
        <button v-if="step.detail?.error && !step.detail.loading" type="button" class="tool-detail-action" @click="send({ action: 'detail', id: step.messageId })">
          {{ labels.retry }}
        </button>
        <button v-if="step.detail?.resourceId" type="button" class="tool-detail-action" @click="send({ action: 'resource', id: step.messageId, resourceId: step.detail.resourceId })">
          {{ labels.openFull }}
        </button>
      </div>
    </article>
    <ReaderProgress v-if="!steps || steps.loading" :label="labels.loadingSteps" />
    <button v-if="steps?.stale && !steps.loading" class="transcript-retry" type="button" @click="load()">
      {{ labels.refreshSteps }}
    </button>
    <button v-else-if="steps && !steps.loading && (steps.failed || steps.nextCursor)" class="transcript-retry" type="button" @click="load(steps.nextCursor)">
      {{ steps.failed ? labels.retrySteps : labels.moreSteps }}
    </button>
  </div>
</template>
