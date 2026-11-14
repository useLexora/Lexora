<script setup lang="ts">
import { ArrowDown20Regular } from '@vicons/fluent'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { provideChatTranscriptPresentation } from '../modules/tasks/reader'
import { useReaderBridge } from './readerBridge'
import ReaderMessage from './ReaderMessage.vue'
import { useReaderStrings } from './readerStrings'
import ReaderToolCall from './ReaderToolCall.vue'
import ReaderTurn from './ReaderTurn.vue'
import { useReaderResultRead } from './useReaderResultRead'
import { useReaderTurns } from './useReaderTurns'
import { useReaderViewport } from './useReaderViewport'

const { entries: messages, runs, transcripts, topic, dark, fontScale, appearance, typography, language, resultRunId, send } = useReaderBridge()
const labels = useReaderStrings(language)
const entries = useReaderTurns(messages, runs, transcripts, topic)
const runBuddyIds = computed(() => new Map(runs.value.map(run => [run.id, run.buddyId])))
provideChatTranscriptPresentation(() => topic.value, () => entries.value.map(entry => entry.id))
const viewport = useTemplateRef('viewport')
useReaderResultRead(viewport, resultRunId, topic, send)
const { rows, height, followsEnd, showLatest, latest, scroll, touch, measure } = useReaderViewport(viewport, entries, topic)
const expanded = shallowRef(new Map<string, boolean>())
const style = computed(() => ({
  ...appearance.value,
  'fontSize': `${typography.value.bodySize * fontScale.value}px`,
  '--buddy-chat-final-line-height': String(typography.value.bodyLineHeight / typography.value.bodySize),
}))
function toggle(id: string, initial = false) {
  followsEnd.value = false
  const next = new Map(expanded.value)
  next.set(id, !(next.get(id) ?? initial))
  expanded.value = next
}
function click(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!link)
    return
  event.preventDefault()
  event.stopPropagation()
  send({ action: 'link', href: link.getAttribute('href') ?? '' })
}
watch(rows, (current) => {
  for (const id of new Set(current.flatMap(row => row.entry.messages.map(message => message.runId).filter((id): id is string => !!id)))) send({ action: 'transcript', runId: id })
}, { flush: 'post' })
watch(runs, (current) => {
  for (const run of current) {
    if (run.status === 'running' || run.status === 'queued')
      send({ action: 'transcript', runId: run.id })
  }
}, { flush: 'post' })
watch(topic, () => {
  expanded.value = new Map()
})
</script>

<template>
  <main :class="{ dark }" :style="style">
    <div ref="viewport" class="reader-viewport" :aria-label="labels.messages" @scroll.passive="scroll" @touchstart.passive="touch(true)" @touchend.passive="touch(false)" @touchcancel.passive="touch(false)" @wheel.passive="followsEnd = false">
      <div class="reader-content" :style="{ height: `${height}px` }" :data-message-count="entries.length" @click.capture="click">
        <section v-for="row in rows" :key="row.entry.id" :ref="measure" class="reader-entry" :class="{ continuation: row.entry.continuation }" :data-entry-id="row.entry.id" :data-index="row.index" :style="{ transform: `translateY(${row.start}px)` }">
          <button v-if="row.entry.transcriptError" class="transcript-retry" @click="send({ action: 'transcript', runId: row.entry.turn?.runId ?? row.entry.messages[0]!.runId!, retry: 'true' })">
            {{ labels.retryTranscript }}
          </button>
          <ReaderTurn v-if="row.entry.turn" :turn="row.entry.turn" :buddy-id="runBuddyIds.get(row.entry.turn.runId)" :messages="row.entry.messages" :dark="dark" :language="language" :send="send" @interact="followsEnd = false" />
          <template v-for="message in row.entry.messages" :key="message.id">
            <ReaderToolCall v-if="!row.entry.turn && message.role === 'tool'" :message="message" :language="language" :expanded="expanded.get(`message:${message.id}`) ?? message.toolError" :send="send" @toggle="toggle(`message:${message.id}`, message.toolError)" @interact="followsEnd = false" />
            <ReaderMessage v-else-if="!row.entry.turn" :message="message" :language="language" :dark="dark" :send="send" @interact="followsEnd = false" />
          </template>
        </section>
        <p v-if="!entries.length" class="reader-empty">
          {{ labels.empty }}
        </p>
      </div>
    </div>
    <button v-if="showLatest" class="latest-button" :aria-label="labels.latest" @click="latest">
      <ArrowDown20Regular class="reader-icon" />
    </button>
  </main>
</template>
