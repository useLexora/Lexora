<script setup lang="ts">
import type { ReaderOutput, ReaderSend } from './readerProtocol'
import { ChevronRight20Regular, DocumentMultiple20Regular } from '@vicons/fluent'
import { useId } from 'vue'
import { useChatTranscriptValue } from '../modules/tasks/reader'
import ReaderArtifactCard from './ReaderArtifactCard.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ runId: string, output?: ReaderOutput, send: ReaderSend }>()
const emit = defineEmits<{ interact: [] }>()
const labels = useReaderStrings()
const open = useChatTranscriptValue(() => `outputs:${props.runId}:open`, true)
const bodyId = useId()
</script>

<template>
  <section v-if="output?.items.length || output?.failed" class="reader-artifacts" :aria-label="labels.artifacts" :data-output-run-id="runId" @click="emit('interact')">
    <button class="artifact-heading" :aria-expanded="open" :aria-controls="bodyId" @click="open = !open">
      <DocumentMultiple20Regular class="h-3.5 w-3.5" aria-hidden="true" />
      <span>{{ labels.artifacts }}</span>
      <span class="text-xs tabular-nums">{{ output.items.length }}</span>
      <ChevronRight20Regular class="artifact-chevron h-3.5 w-3.5" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <div v-show="open" :id="bodyId" class="artifact-strip">
      <ReaderArtifactCard v-for="item in output.items" :key="`${item.id}:${item.revision}`" :item="item" :run-id="runId" :send="send" />
    </div>
    <button v-if="output.failed" class="transcript-retry" @click="send({ action: 'outputs', runId, retry: 'true' })">
      {{ labels.retryArtifacts }}
    </button>
  </section>
</template>

<style scoped lang="scss">
.reader-artifacts {
  min-width: 0;
  margin-top: 10px;
}
.artifact-heading {
  display: flex;
  align-items: center;
  width: fit-content;
  min-height: 28px;
  padding: 2px 0;
  color: var(--reader-muted);
  font-size: 13px;
  line-height: 20px;

  > * + * {
    margin-left: 6px;
  }
}
.artifact-chevron {
  transition: transform 120ms ease;

  &.is-open {
    transform: rotate(90deg);
  }
}
.artifact-strip {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: min(224px, 75vw);
  gap: 8px;
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 2px 0 4px;
}
@media (prefers-reduced-motion: reduce) {
  .artifact-chevron {
    transition: none;
  }
}
</style>
