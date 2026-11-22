<script setup lang="ts">
import type { ReaderUpdate } from './readerProtocol'
import { ArrowClockwise20Regular } from '@vicons/fluent'
import { useTimeoutFn } from '@vueuse/core'
import { shallowRef, watch } from 'vue'
import ReaderProgress from './ReaderProgress.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ history: NonNullable<ReaderUpdate['history']> }>()
defineEmits<{ retry: [] }>()
const labels = useReaderStrings()
const slow = shallowRef(false)
const timer = useTimeoutFn(() => slow.value = true, 250, { immediate: false })
watch(() => props.history.loading, (loading) => {
  slow.value = false
  if (loading)
    timer.start()
  else
    timer.stop()
}, { immediate: true })
</script>

<template>
  <div v-if="history.loading && slow" class="history-notice history-progress">
    <ReaderProgress :label="labels.loadingEarlier" />
  </div>
  <button v-else-if="history.available && !history.loading && history.error" class="history-notice history-retry" type="button" :aria-label="labels.retryEarlier" @click="$emit('retry')">
    <ArrowClockwise20Regular aria-hidden="true" width="20" height="20" />
  </button>
</template>

<style scoped lang="scss">
.history-notice {
  position: absolute;
  z-index: 1;
  inset-block-start: 6px;
  inset-inline-end: 12px;
  display: grid;
  place-items: center;
  inline-size: 44px;
  block-size: 44px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--reader-border);
  border-radius: 50%;
  background: var(--reader-panel);
  color: var(--reader-muted);
  font: inherit;
  font-size: .875em;
}
.history-progress { pointer-events: none; }
.history-retry { color: var(--reader-accent); }
.history-retry:focus-visible { outline: 2px solid var(--reader-accent); }
</style>
