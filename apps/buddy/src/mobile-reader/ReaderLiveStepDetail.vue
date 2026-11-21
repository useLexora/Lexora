<script setup lang="ts">
import type { ReaderSend, ReaderStepDetailReply } from './readerProtocol'
import { inject, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { nextStepRead, readerStepDetailKey } from './readerStepDetail'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ runId: string, groupId: string, stepId: string, send: ReaderSend }>()
const reply = inject(readerStepDetailKey)
const labels = useReaderStrings()
const panel = useTemplateRef('panel')
const text = ref('')
const loading = ref(false)
const truncated = ref(false)
const error = ref<ReaderStepDetailReply['error']>(null)
let running = true
let revision: string | undefined
let pending: string | undefined
let mounted = false
let visible = true
let timer: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | undefined
function read() {
  if (!mounted || document.hidden || !visible || pending)
    return
  pending = nextStepRead()
  loading.value = !revision
  error.value = null
  props.send({ action: 'read-step-detail', runId: props.runId, groupId: props.groupId, stepId: props.stepId, requestId: pending, ...(revision && { knownRevision: revision }) })
}
function stop() {
  clearTimeout(timer)
  if (pending)
    props.send({ action: 'stop-step-detail', requestId: pending })
  pending = undefined
  loading.value = false
}
function visibility() {
  clearTimeout(timer)
  if (document.hidden || !visible)
    stop()
  else if (running && !error.value)
    read()
}
if (reply) {
  watch(reply, (r) => {
    if (!mounted || !r || r.stepId !== props.stepId || r.requestId !== pending)
      return
    pending = undefined
    loading.value = false
    const result = r.result
    if (!result || result.stepId !== props.stepId) {
      error.value = r.error ?? 'retry'
      return
    }
    if (!result.available)
      text.value = ''
    else if (result.text !== null)
      text.value = result.text
    truncated.value = result.truncated
    revision = result.revision
    running = result.status === 'running' && !result.messageId
    if (running && visible && !document.hidden)
      timer = setTimeout(read, 3000)
  }, { flush: 'sync' })
}
onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', visibility)
  if (typeof IntersectionObserver !== 'undefined' && panel.value) {
    visible = false
    observer = new IntersectionObserver(([entry]) => {
      if (visible === !!entry?.isIntersecting)
        return
      visible = !!entry?.isIntersecting
      visibility()
    })
    observer.observe(panel.value)
  }
  else {
    read()
  }
})
onUnmounted(() => {
  mounted = false
  stop()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', visibility)
})
</script>

<template>
  <div ref="panel" class="tool-call-detail">
    <pre v-if="text" class="tool-output">{{ text }}</pre>
    <p v-if="loading" class="message-meta" role="status">
      {{ labels.loadingOutput }}
    </p>
    <p v-else-if="error === 'unsupported'" class="message-meta">
      {{ labels.stepUpgrade }}
    </p>
    <button v-else-if="error === 'retry'" type="button" class="tool-detail-action" @click="read">
      {{ labels.retrySteps }}
    </button>
    <p v-else-if="!text || error === 'unavailable'" class="message-meta">
      {{ labels.noStepDisplay }}
    </p>
    <p v-if="truncated" class="message-meta">
      {{ labels.stepPreview }}
    </p>
  </div>
</template>
