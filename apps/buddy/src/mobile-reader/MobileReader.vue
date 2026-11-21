<script setup lang="ts">
import { ArrowDown20Regular } from '@vicons/fluent'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { provideChatTranscriptPresentation } from '../modules/tasks/reader'
import ReaderActivityGroup from './ReaderActivityGroup.vue'
import { useReaderBridge } from './readerBridge'
import ReaderHistoryState from './ReaderHistoryState.vue'
import ReaderMessage from './ReaderMessage.vue'
import ReaderRunStatus from './ReaderRunStatus.vue'
import { useReaderStrings } from './readerStrings'
import ReaderToolCall from './ReaderToolCall.vue'
import ReaderTurn from './ReaderTurn.vue'
import { provideReaderBranches } from './useReaderBranches'
import { useReaderResultRead } from './useReaderResultRead'
import { useReaderTurns } from './useReaderTurns'
import { useReaderViewport } from './useReaderViewport'

const { entries: messages, history, turnWindow, runs, transcripts, outputs, branches, selectedBranchId, topic, dark, fontScale, appearance, typography, language, resultRunId, anchor, hasLaterMessages, send } = useReaderBridge()
provideReaderBranches(messages, runs, branches, selectedBranchId)
const labels = useReaderStrings(language)
const entries = useReaderTurns(messages, runs, transcripts, topic, anchor, turnWindow)
const lastAssistantIds = computed(() => new Map(messages.value.flatMap(entry => entry.messages).filter(message => message.role === 'assistant' && message.runId).map(message => [message.runId, message.id])))
const runBuddyIds = computed(() => new Map(runs.value.map(run => [run.id, run.buddyId])))
provideChatTranscriptPresentation(() => topic.value, () => entries.value.map(entry => entry.id))
const viewport = useTemplateRef('viewport')
useReaderResultRead(viewport, resultRunId, topic, send)
const { rows, height, nearHistoryStart, retryOlder, followsEnd, showLatest, anchorStatus, locatedMessageId, latest, scroll, touch, measure } = useReaderViewport(viewport, entries, topic, anchor, hasLaterMessages, () => send({ action: 'latest' }), {
  state: history,
  load: retry => send(retry ? { action: 'older', retry: true } : { action: 'older' }),
})
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
watch([rows, turnWindow], ([current, compact]) => {
  for (const id of new Set(current.flatMap(row => [row.entry.turn?.runId, row.entry.activityGroup?.runId, row.entry.runStatus?.run.id, ...row.entry.messages.map(message => message.runId)]).filter((id): id is string => !!id))) {
    if (!compact)
      send({ action: 'transcript', runId: id })
    send({ action: 'outputs', runId: id })
  }
}, { flush: 'post' })
watch([runs, turnWindow], ([current, compact]) => {
  if (compact)
    return
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
  <main :class="{ dark }" :style="style" :data-anchor-status="anchorStatus" :data-anchor-message-id="locatedMessageId">
    <p v-if="anchorStatus === 'missing'" class="anchor-notice" role="status">
      {{ labels.anchorMissing }}
    </p>
    <div ref="viewport" class="reader-viewport" :aria-label="labels.messages" @scroll.passive="scroll" @touchstart.passive="touch(true)" @touchend.passive="touch(false)" @touchcancel.passive="touch(false)" @wheel.passive="touch(true); followsEnd = false; touch(false)">
      <div :key="topic" class="reader-content" :style="{ height: `${height}px` }" :data-message-count="entries.length" @click.capture="click">
        <section v-for="row in rows" :key="row.entry.id" :ref="measure" class="reader-entry" :class="{ continuation: row.entry.continuation }" :data-entry-id="row.entry.id" :data-index="row.index" :style="{ transform: `translateY(${row.start}px)` }">
          <button v-if="row.entry.transcriptError" class="transcript-retry" @click="send({ action: 'transcript', runId: row.entry.turn?.runId ?? row.entry.messages[0]!.runId!, retry: 'true' })">
            {{ labels.retryTranscript }}
          </button>
          <ReaderActivityGroup v-if="row.entry.activityGroup" :row-id="row.entry.id" :group="row.entry.activityGroup" :steps="row.entry.steps" :language="language" :send="send" @click="followsEnd = false" />
          <ReaderRunStatus v-else-if="row.entry.runStatus" :status="row.entry.runStatus" :row-id="row.entry.id" :output="outputs[row.entry.runStatus.run.id]" :send="send" @interact="followsEnd = false" />
          <ReaderTurn v-else-if="row.entry.turn" :turn="row.entry.turn" :output="outputs[row.entry.turn.runId]" :buddy-id="runBuddyIds.get(row.entry.turn.runId)" :messages="row.entry.messages" :dark="dark" :language="language" :send="send" @interact="followsEnd = false" />
          <template v-for="message in row.entry.messages" :key="message.id">
            <ReaderToolCall v-if="(!turnWindow || anchor || hasLaterMessages) && !row.entry.turn && message.role === 'tool'" :message="message" :language="language" :expanded="expanded.get(`message:${message.id}`) ?? (!turnWindow && (anchor?.messageId === message.id || message.toolError))" :send="send" @toggle="toggle(`message:${message.id}`, !turnWindow && (anchor?.messageId === message.id || message.toolError))" @interact="followsEnd = false" />
            <ReaderMessage v-else-if="!row.entry.turn && message.role !== 'tool'" :message="message" :output="message.runId && lastAssistantIds.get(message.runId) === message.id ? outputs[message.runId] : undefined" :language="language" :dark="dark" :send="send" @interact="followsEnd = false" />
          </template>
        </section>
        <p v-if="topic && !entries.length && !history?.loading && !history?.error" class="reader-empty">
          {{ labels.empty }}
        </p>
      </div>
    </div>
    <ReaderHistoryState v-if="history && nearHistoryStart && anchorStatus !== 'missing'" :key="topic" :history="history" @retry="retryOlder" />
    <button v-if="showLatest" class="latest-button" :aria-label="labels.latest" @click="latest">
      <ArrowDown20Regular class="reader-icon" />
    </button>
  </main>
</template>

<style scoped lang="scss">
.anchor-notice {
  position: absolute;
  z-index: 1;
  inset: 8px 16px auto;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  background: var(--reader-panel);
  color: var(--reader-muted);
}
</style>
