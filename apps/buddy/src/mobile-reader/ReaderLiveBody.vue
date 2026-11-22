<script setup lang="ts">
import type { ReaderMessage, ReaderSend, ReaderUpdate } from './readerProtocol'
import { computed, inject, shallowRef, watch } from 'vue'
import { readerBodyPageKey } from './readerBodyPages'
import ReaderProgress from './ReaderProgress.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ message: Pick<ReaderMessage, 'id' | 'textRange' | 'text'>, send: ReaderSend }>()
const emit = defineEmits<{ interact: [] }>()
const labels = useReaderStrings()
const responses = inject(readerBodyPageKey)
type Page = NonNullable<NonNullable<ReaderUpdate['bodyPage']>['page']>
interface Intent { revision: string, direction: 'before' | 'after', offset: number, total: number, forward: boolean }
const held = shallowRef<Page>()
const pending = shallowRef<Intent>()
const retry = shallowRef<Intent>()
const later = shallowRef<number[]>([])
const latestPage = computed(() => ({ range: props.message.textRange!, text: props.message.text }))
const current = computed(() => held.value ?? latestPage.value)
const saved = computed(() => /^(?:s|c):/.test(current.value.range.revision))
const canAdvance = computed(() => saved.value ? current.value.range.end < current.value.range.total : later.value.length > 0)
function latest() {
  held.value = undefined
  pending.value = undefined
  later.value = []
  retry.value = undefined
}
function request(direction: 'before' | 'after', offset: number, forward = false, anchor = current.value) {
  if (pending.value)
    return
  held.value ??= anchor
  retry.value = undefined
  const { total, revision } = anchor.range
  pending.value = { revision, direction, offset, total, forward }
  props.send(direction === 'before' ? { action: 'body-before', id: props.message.id, revision, before: offset } : { action: 'body-after', id: props.message.id, revision, after: offset })
}
function read(direction: 'before' | 'after' | 'first') {
  emit('interact')
  if (direction === 'after' && !saved.value)
    request('before', later.value.at(-1)!, true)
  else if (direction === 'first')
    request('after', 0)
  else
    request(direction, direction === 'after' ? current.value.range.end : current.value.range.start)
}
watch(() => props.message.id, latest)
watch(() => props.message.textRange, (range, old) => {
  if (!range || !old || old.revision === range.revision || !/^(?:s|c):/.test(range.revision))
    return
  const anchor = held.value?.range.start
  latest()
  if (anchor !== undefined && anchor < range.start)
    request('after', Math.min(anchor, range.total), false, latestPage.value)
  else if (old.end - old.start > range.end - range.start && range.start > 0)
    request('before', range.end, false, latestPage.value)
})
if (responses) {
  watch(responses, (result) => {
    const req = pending.value
    if (!req || !result || result.id !== props.message.id || result.revision !== req.revision || result[req.direction] !== req.offset)
      return
    pending.value = undefined
    const page = result.page
    if (!page || page.range.revision !== req.revision || page.range.total !== req.total || page.range.end > req.total
      || page.range.start >= page.range.end || page.range.end - page.range.start !== page.text.length
      || (req.direction === 'before' ? page.range.end !== req.offset : page.range.start !== req.offset && page.range.start !== req.offset - 1)) {
      retry.value = req
      return
    }
    if (!saved.value)
      later.value = req.forward ? later.value.slice(0, -1) : [...later.value.slice(-127), current.value.range.end]
    held.value = page
  })
}
</script>

<template>
  <p v-if="current.range.start > 0" class="message-meta">
    <button :disabled="!!pending" @click="read('before')">
      {{ labels.previousBody }}
    </button>
    <button v-if="saved" :disabled="!!pending" @click="read('first')">
      {{ labels.bodyFromStart }}
    </button>
  </p>
  <p class="plain-message">
    {{ current.text }}
  </p>
  <ReaderProgress v-if="pending" :label="labels.loadingSaved" />
  <p v-else-if="retry" class="message-meta" role="status">
    {{ labels.bodyReadFailed }}
    <button @click="request(retry.direction, retry.offset, retry.forward)">
      {{ labels.retry }}
    </button>
  </p>
  <p v-if="held" class="message-meta">
    <button v-if="canAdvance" :disabled="!!pending" @click="read('after')">
      {{ labels.nextBody }}
    </button>
    <button v-if="!saved || current.range.end !== current.range.total" @click="latest">
      {{ saved ? labels.bodyEnding : labels.liveBody }}
    </button>
  </p>
</template>
