<script setup lang="ts">
import { ArrowClockwise20Regular, ArrowDown20Regular } from '@vicons/fluent'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { provideChatTranscriptPresentation } from '../modules/tasks/reader'
import ReaderActivityGroup from './ReaderActivityGroup.vue'
import { useReaderBridge } from './readerBridge'
import ReaderHistoryState from './ReaderHistoryState.vue'
import ReaderMessage from './ReaderMessage.vue'
import ReaderProgress from './ReaderProgress.vue'
import ReaderRunStatus from './ReaderRunStatus.vue'
import { useReaderStrings } from './readerStrings'
import ReaderToolCall from './ReaderToolCall.vue'
import ReaderTurn from './ReaderTurn.vue'
import { provideReaderBranches } from './useReaderBranches'
import { useReaderComposerActivity } from './useReaderComposerActivity'
import { useReaderLatestPull } from './useReaderLatestPull'
import { useReaderResultRead } from './useReaderResultRead'
import { useReaderTurns } from './useReaderTurns'
import { useReaderViewport } from './useReaderViewport'

const { entries: messages, composerActivity, history, turnWindow, canLoadTranscript, runs, buddyNames, transcripts, outputs, branches, selectedBranchId, topic, dark, fontScale, appearance, typography, language, resultRunId, anchor, hasLaterMessages, latestState, send } = useReaderBridge()
provideReaderBranches(messages, runs, branches, selectedBranchId)
const labels = useReaderStrings(language)
const entries = useReaderTurns(messages, runs, transcripts, topic, anchor, turnWindow, outputs)
const legacyActivity = computed(() => !turnWindow.value && !hasLaterMessages.value && composerActivity.value
  ? entries.value.find(entry => entry.turn?.runId === composerActivity.value!.runId)?.turn
  : undefined)
useReaderComposerActivity(composerActivity, () => legacyActivity.value, language, send)
const lastAssistantIds = computed(() => new Map(messages.value.flatMap(entry => entry.messages).filter(message => message.role === 'assistant' && message.runId).map(message => [message.runId, message.id])))
provideChatTranscriptPresentation(() => topic.value, () => entries.value.map(entry => entry.id))
const viewport = useTemplateRef('viewport')
useReaderResultRead(viewport, resultRunId, topic, send)
const { rows, height, nearHistoryStart, retryOlder, followsEnd, showLatest, anchorStatus, locatedMessageId, latest, scroll, touch, measure } = useReaderViewport(viewport, entries, topic, anchor, hasLaterMessages, {
  state: history,
  load: retry => send(retry ? { action: 'older', retry: true } : { action: 'older' }),
})
const loadingLatest = computed(() => hasLaterMessages.value && latestState.value?.loading === true)
const latestError = computed(() => hasLaterMessages.value ? latestState.value?.error : null)
const latestLabel = computed(() => loadingLatest.value ? labels.value.loadingLatest : latestError.value ? `${labels.value.retryLatest}: ${latestError.value}` : labels.value.latest)
function activateLatest() {
  if (hasLaterMessages.value) {
    if (!loadingLatest.value)
      send({ action: 'latest' })
  }
  else {
    latest()
  }
}
useReaderLatestPull(viewport, () => hasLaterMessages.value && !loadingLatest.value ? topic.value : null, activateLatest)
const activeRuns = computed(() => runs.value.filter(run => run.status === 'running' || run.status === 'queued'))
const liveTurnOwners = computed(() => {
  const current = turnWindow.value || hasLaterMessages.value || anchor.value ? [] : activeRuns.value
  return new Map(current.filter(run => !selectedBranchId.value || run.branchId === selectedBranchId.value)
    .map(run => [run.id, {
      id: run.buddyId,
      name: run.executionKind === 'root' || run.executionKind === 'actor_child' ? buddyNames.value.get(run.buddyId) : undefined,
    }]))
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
const visibleRunIds = computed(() => new Set(rows.value.flatMap(row => [row.entry.turn?.runId, row.entry.activityGroup?.runId, row.entry.runStatus?.run.id, ...row.entry.messages.map(message => message.runId)]).filter((id): id is string => !!id)))
const presentedTopic = shallowRef<string | null>(null)
const locatingTail = computed(() => followsEnd.value && rows.value.at(-1)?.index !== entries.value.length - 1)
const waitingForTranscript = computed(() => {
  if (presentedTopic.value === topic.value || turnWindow.value || !canLoadTranscript.value || hasLaterMessages.value || anchor.value)
    return false
  return runs.value.some(run => run.status === 'completed' && (!run.executionKind || run.executionKind === 'root')
    && (locatingTail.value || visibleRunIds.value.has(run.id)) && !transcripts.value[run.id]?.loaded && !transcripts.value[run.id]?.error)
})
watch(topic, () => {
  presentedTopic.value = null
})
watch([rows, topic, waitingForTranscript], () => {
  if (rows.value.length && !waitingForTranscript.value)
    presentedTopic.value = topic.value
}, { flush: 'post' })
const presentedRows = computed(() => waitingForTranscript.value ? [] : rows.value)
watch([rows, turnWindow, waitingForTranscript, locatingTail], ([current, compact, waiting, locating]) => {
  if (waiting && locating)
    return
  const ids = new Set(visibleRunIds.value)
  if (compact) {
    const inputs = new Set(current.flatMap(row => row.entry.messages.filter(message => message.role === 'user').map(message => message.id)))
    for (const run of activeRuns.value) {
      if (inputs.has(run.triggeringMessageId))
        ids.add(run.id)
    }
  }
  for (const id of ids) {
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
        <section v-for="row in presentedRows" :key="row.entry.id" :ref="measure" class="reader-entry" :class="{ continuation: row.entry.continuation }" :data-entry-id="row.entry.id" :data-index="row.index" :style="{ transform: `translateY(${row.start}px)` }">
          <button v-if="row.entry.transcriptError" class="transcript-retry" @click="send({ action: 'transcript', runId: row.entry.turn?.runId ?? row.entry.messages[0]!.runId!, retry: 'true' })">
            {{ labels.retryTranscript }}
          </button>
          <ReaderActivityGroup v-if="row.entry.activityGroup" :row-id="row.entry.id" :group="row.entry.activityGroup" :owner="row.entry.groupOwner" :historical="hasLaterMessages" :steps="row.entry.steps" :language="language" :send="send" @click="followsEnd = false" />
          <ReaderRunStatus v-else-if="row.entry.runStatus" :status="row.entry.runStatus" :row-id="row.entry.id" :output="outputs[row.entry.runStatus.run.id]" :send="send" @interact="followsEnd = false" />
          <ReaderTurn v-else-if="row.entry.turn" :turn="row.entry.turn" :output="outputs[row.entry.turn.runId]" :live-owner="liveTurnOwners.get(row.entry.turn.runId)" :messages="row.entry.messages" :dark="dark" :language="language" :send="send" @interact="followsEnd = false" />
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
    <div v-if="waitingForTranscript" class="initial-progress">
      <ReaderProgress :label="labels.loadingLatest" />
    </div>
    <ReaderHistoryState v-if="history && nearHistoryStart && anchorStatus !== 'missing'" :key="topic" :history="history" @retry="retryOlder" />
    <button v-if="hasLaterMessages || showLatest" type="button" class="latest-button" :class="{ 'latest-failed': latestError }" :disabled="loadingLatest" :aria-busy="loadingLatest" :aria-label="latestLabel" :title="latestLabel" @click="activateLatest">
      <span v-if="loadingLatest" class="latest-spinner" aria-hidden="true" />
      <ArrowClockwise20Regular v-else-if="latestError" class="reader-icon" aria-hidden="true" />
      <ArrowDown20Regular v-else class="reader-icon" aria-hidden="true" />
    </button>
  </main>
</template>

<style scoped lang="scss">
.initial-progress {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  color: var(--reader-muted);
}
.latest-failed { color: var(--reader-accent); }
.latest-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--reader-border);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: latest-spin .8s linear infinite;
}
@keyframes latest-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .latest-spinner { animation: none; }
}
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
