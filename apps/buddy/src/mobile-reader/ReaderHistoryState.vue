<script setup lang="ts">
import type { ReaderUpdate } from './readerProtocol'
import { useTimeoutFn } from '@vueuse/core'
import { shallowRef, watch } from 'vue'
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
  <p v-if="history.loading && slow" class="history-notice history-progress" role="status">
    {{ labels.loadingEarlier }}
  </p>
  <button v-else-if="history.available && !history.loading && history.error" class="history-notice history-retry" type="button" @click="$emit('retry')">
    {{ labels.retryEarlier }}
  </button>
</template>

<style scoped lang="scss">
.history-notice {
  position: absolute;
  z-index: 1;
  inset-block-start: 6px;
  inset-inline-end: 12px;
  max-inline-size: calc(100% - 24px);
  margin: 0;
  padding: 4px 12px;
  border: 1px solid var(--reader-border);
  border-radius: 16px;
  background: var(--reader-panel);
  color: var(--reader-muted);
  font: inherit;
  font-size: .875em;
}
.history-progress { pointer-events: none; }
.history-retry {
  min-block-size: 44px;
  color: var(--reader-accent);
}
.history-retry:focus-visible { outline: 2px solid var(--reader-accent); }
</style>
