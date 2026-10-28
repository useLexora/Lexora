<script setup lang="ts">
import type { DesktopChatOutlinePosition } from '@buddy-electron/shared/desktopApi'
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'

import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'
import type { ChatTranscriptDisplayRow } from '../../model/transcript/chatMessageTime'
import type { ChatOutlineItem } from '../../model/transcript/chatOutline'
import type { ChatTranscriptRow } from '../../model/transcript/chatTranscriptProjection'
import type {
  BuddyChatMessageListHandle,
  BuddyChatTranscriptViewportHandle,
  ChatMessageScrollAnchor,
  ChatMessageScrollMetrics,
} from './chatMessageViewport'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NSpin } from 'naive-ui'
import { computed, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { getChatMessageFollowupSourceId } from '../../model/transcript/chatMessageActions'
import {
  formatChatDayDividerLabel,
} from '../../model/transcript/chatMessageTime'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import BuddyExecutionGroup from '../executions/BuddyExecutionGroup.vue'
import BuddyChatAgentTurn from './BuddyChatAgentTurn.vue'
import BuddyChatAgentTurnFlow from './BuddyChatAgentTurnFlow.vue'
import BuddyChatCompactionRow from './BuddyChatCompactionRow.vue'
import BuddyChatExecutionInput from './BuddyChatExecutionInput.vue'
import BuddyChatMessageRow from './BuddyChatMessageRow.vue'
import BuddyChatOutline from './BuddyChatOutline.vue'
import BuddyChatRunActivity from './BuddyChatRunActivity.vue'
import BuddyChatTranscriptViewport from './BuddyChatTranscriptViewport.vue'
import BuddyChatTurnResult from './BuddyChatTurnResult.vue'

const props = defineProps<{
  activeBranchId: string
  actionsDisabled?: boolean
  branchNavigators: ReadonlyMap<string, ChatMessageBranchNavigator>
  conversationId: string
  displayRows: ReadonlyArray<ChatTranscriptDisplayRow>
  editingMessageId?: string | null
  followupMessageId?: string | null
  followupMessageIds?: ReadonlySet<string>
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  isRestoringPosition?: boolean
  language: BuddyLocale
  stoppingRunId?: string | null
  outlineItems: ReadonlyArray<ChatOutlineItem>
  outlineLoading: boolean
  outlinePosition: DesktopChatOutlinePosition
  showReturnToLatest?: boolean
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  editUserMessage: [messageId: string]
  openArtifact: [artifact: LocalArtifact]
  openChanges: [changeSetId: string]
  prepareOutline: []
  readerLayoutIntent: []
  readerScrollIntent: []
  regenerateAssistant: [sourceRunId: string]
  followupAssistant: [assistantMessageId: string, branchId: string]
  returnToLatest: []
  selectOutlineMessage: [messageId: string]
  scroll: [metrics: ChatMessageScrollMetrics, options?: { userInitiated?: boolean }]
  contentResize: [metrics: ChatMessageScrollMetrics]
}>()

const { t } = useBuddyI18n(() => props.language)
const historyElement = useTemplateRef<HTMLElement>('historyElement')
useWorkbenchAnchor('task.history', () => historyElement.value)
const transcriptViewport = useTemplateRef<BuddyChatTranscriptViewportHandle>('transcriptViewport')
const OUTLINE_HIGHLIGHT_DURATION_MS = 1_200
const activeOutlineMessageId = shallowRef<string | null>(null)
const highlightedOutlineMessageId = shallowRef<string | null>(null)
const executionTree = useExecutionTree()
const executionAnchors = computed(() => {
  const anchors = new Map<string, string>()
  const seen = new Set<string>()
  for (const row of props.displayRows) {
    const runId = row.kind === 'agent-turn' || row.kind === 'activity'
      ? row.turn.runId
      : row.kind === 'message' && row.message.role === 'assistant' ? row.message.runId : null
    const rootRunId = runId ? executionTree?.groups.value.byRun.get(runId)?.rootRunId ?? runId : null
    if (rootRunId && !seen.has(rootRunId)) {
      seen.add(rootRunId)
      anchors.set(row.key, rootRunId)
    }
  }
  return anchors
})
let outlineHighlightTimer: number | null = null
watch([() => props.conversationId, () => props.activeBranchId], () => {
  activeOutlineMessageId.value = null
  clearOutlineHighlight()
})

function recoveryNoticeLabel(
  notice: Extract<ChatTranscriptRow, { kind: 'recovery-notice' }>['notice'],
): string {
  return t('desktop.chat.recoveryAttachmentsMissing', {
    count: notice.missingAttachmentCount,
  })
}

function readScrollMetrics(): ChatMessageScrollMetrics | null {
  return transcriptViewport.value?.readScrollMetrics() ?? null
}

function captureScrollAnchor(): ChatMessageScrollAnchor | null {
  return transcriptViewport.value?.captureScrollAnchor() ?? null
}

function hasScrollAnchor(anchor: ChatMessageScrollAnchor): boolean {
  return transcriptViewport.value?.hasScrollAnchor(anchor) ?? false
}

function restoreScrollAnchor(anchor: ChatMessageScrollAnchor): ChatMessageScrollMetrics | null {
  return transcriptViewport.value?.restoreScrollAnchor(anchor) ?? null
}

function scrollToTail(): ChatMessageScrollMetrics | null {
  return transcriptViewport.value?.scrollToTail() ?? null
}

function scrollToMessage(
  messageId: string,
  behavior?: ScrollBehavior,
): ChatMessageScrollMetrics | null {
  return transcriptViewport.value?.scrollToMessage(resolveFollowupSourceId(messageId), behavior) ?? null
}

function resolveFollowupSourceId(messageId: string) {
  const row = props.displayRows.find(row => row.kind === 'message' && row.turnResult?.finalMessageId === messageId)
  return row?.kind === 'message' ? row.message.id : messageId
}

function highlightMessage(messageId: string) {
  clearOutlineHighlight()
  highlightedOutlineMessageId.value = resolveFollowupSourceId(messageId)
  outlineHighlightTimer = window.setTimeout(() => {
    highlightedOutlineMessageId.value = null
    outlineHighlightTimer = null
  }, OUTLINE_HIGHLIGHT_DURATION_MS)
}

function clearOutlineHighlight() {
  if (outlineHighlightTimer !== null)
    window.clearTimeout(outlineHighlightTimer)
  outlineHighlightTimer = null
  highlightedOutlineMessageId.value = null
}

function scrollTranscript(deltaY: number) {
  transcriptViewport.value?.scrollBy(deltaY)
}

function handleReaderLayoutIntent(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest('button[aria-expanded]'))
    emit('readerLayoutIntent')
}

defineExpose<BuddyChatMessageListHandle>({
  captureScrollAnchor,
  hasScrollAnchor,
  highlightMessage,
  readScrollMetrics,
  restoreScrollAnchor,
  scrollToMessage,
  scrollToTail,
})

onBeforeUnmount(clearOutlineHighlight)
</script>

<template>
  <div
    ref="historyElement"
    class="buddy-chat-message-list relative h-full min-w-0 min-h-0"
    role="log"
    data-theme-surface="layout"
    @click.capture="handleReaderLayoutIntent"
  >
    <div
      v-if="isRestoringPosition || isLoadingOlderMessages"
      class="buddy-chat-message-list__history-status absolute z-2 top-[0.45rem] left-[50%] flex max-w-[calc(100%_-_1rem)] items-center gap-[0.4rem] border-1 border-solid border-border rounded-micro bg-raised text-muted text-[0.68rem] py-1 px-[0.6rem]"
      role="status"
    >
      <NSpin :size="14" />
      <span>{{ t(isRestoringPosition ? 'desktop.chat.restoringPosition' : 'desktop.chat.loadingOlder') }}</span>
      <NButton v-if="isRestoringPosition" size="tiny" text @click="emit('returnToLatest')">
        {{ t('desktop.chat.returnToLatest') }}
      </NButton>
    </div>
    <BuddyChatOutline
      :key="`${conversationId}:${activeBranchId}`"
      :active-message-id="activeOutlineMessageId"
      :is-loading="outlineLoading"
      :items="outlineItems"
      :language="language"
      :position="outlinePosition"
      @prepare="emit('prepareOutline')"
      @select="emit('selectOutlineMessage', $event)"
      @scroll-transcript="scrollTranscript"
    />
    <BuddyChatTranscriptViewport
      ref="transcriptViewport"
      :has-older-messages="hasOlderMessages ?? false"
      :return-to-latest-label="t('desktop.chat.returnToLatest')"
      :show-return-to-latest="showReturnToLatest ?? false"
      @active-message-change="activeOutlineMessageId = $event"
      @content-resize="emit('contentResize', $event)"
      @reader-scroll-intent="emit('readerScrollIntent')"
      @return-to-latest="emit('returnToLatest')"
      @scroll="(metrics, options) => emit('scroll', metrics, options)"
    >
      <template v-for="item in displayRows" :key="item.key">
        <div
          v-if="item.kind === 'day-divider'"
          class="buddy-chat-day-divider buddy-chat-transcript-row"
        >
          <time :datetime="item.createdAt">
            {{ formatChatDayDividerLabel(item.createdAt, language) }}
          </time>
        </div>

        <BuddyChatMessageRow
          v-else-if="item.kind === 'message'"
          :data-chat-row-key="item.key"
          :actions-disabled="actionsDisabled ?? false"
          :branch-navigator="branchNavigators.get(item.turnResult?.runId ?? item.message.id) ?? null"
          class="buddy-chat-transcript-row" :class="[
            { 'is-outline-highlighted': item.message.id === highlightedOutlineMessageId, 'is-speech-end': item.endsSpeech },
          ]"
          :is-intermediate="item.isIntermediate"
          :show-identity="item.showIdentity"
          :show-actions="item.showActions"
          :action-messages="item.actionMessages"
          :process-run-id="item.processRunId"
          :result-run-id="item.resultRunId"
          :owns-result-actions="item.ownsResultActions"
          :editing="item.message.id === editingMessageId"
          :can-followup="followupMessageIds?.has(getChatMessageFollowupSourceId(item) ?? '')"
          :following-up="!!followupMessageId && getChatMessageFollowupSourceId(item) === followupMessageId"
          :execution-status="item.executionStatus"
          :language="language"
          :message="item.message"
          :streaming="item.streaming === true"
          :turn-outputs="item.turnOutputs"
          :turn-changes="item.turnChanges"
          :turn-result="item.turnResult"
          :turn-usage="item.turnResult ? executionTree?.groups.value.byRoot.get(item.turnResult.runId)?.usage ?? undefined : item.ownsResultActions && item.resultRunId ? executionTree?.groups.value.byRoot.get(item.resultRunId)?.usage ?? undefined : undefined"
          @activate-branch="emit('activateBranch', $event)"
          @open-artifact="emit('openArtifact', $event)"
          @open-changes="emit('openChanges', $event)"
          @regenerate="emit('regenerateAssistant', $event)"
          @followup="emit('followupAssistant', $event, item.turnResult?.branchId ?? item.message.branchId)"
          @start-edit="emit('editUserMessage', item.message.id)"
        >
          <template #before-actions>
            <BuddyExecutionGroup
              v-if="executionAnchors.has(item.key)"
              :key="`${conversationId}:${activeBranchId}:${executionAnchors.get(item.key)}`"
              :root-run-id="executionAnchors.get(item.key)!"
              :language="language"
            />
          </template>
        </BuddyChatMessageRow>

        <BuddyChatExecutionInput
          v-else-if="item.kind === 'execution-input'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :input="item.input"
          :language="language"
        />

        <BuddyChatTurnResult
          v-else-if="item.kind === 'turn-result'"
          :data-chat-row-key="item.key"
          :data-message-id="item.turn.finalMessageId ?? undefined"
          :actions-disabled="actionsDisabled ?? false"
          :branch-navigator="branchNavigators.get(item.turn.runId) ?? null"
          class="buddy-chat-transcript-row"
          :class="{ 'is-outline-highlighted': item.turn.finalMessageId === highlightedOutlineMessageId }"
          :language="language"
          :turn="item.turn"
          :following-up="item.turn.finalMessageId !== null && item.turn.finalMessageId === followupMessageId"
          :can-followup="item.turn.finalMessageId !== null && followupMessageIds?.has(item.turn.finalMessageId)"
          :usage="executionTree?.groups.value.byRoot.get(item.turn.runId)?.usage ?? null"
          @activate-branch="emit('activateBranch', $event)"
          @regenerate="emit('regenerateAssistant', item.turn.runId)"
          @followup="item.turn.finalMessageId && emit('followupAssistant', item.turn.finalMessageId, item.turn.branchId)"
        />

        <BuddyChatAgentTurn
          v-else-if="item.kind === 'agent-turn'"
          :data-chat-row-key="item.key"
          :actions-disabled="actionsDisabled ?? false"
          :branch-navigator="branchNavigators.get(item.turn.runId) ?? null"
          class="buddy-chat-transcript-row"
          :class="{ 'is-speech-end': item.endsSpeech }"
          :language="language"
          :owns-result-actions="item.ownsResultActions === true"
          :following-up="item.turn.finalMessageId !== null && item.turn.finalMessageId === followupMessageId"
          :can-followup="item.turn.finalMessageId !== null && followupMessageIds?.has(item.turn.finalMessageId)"
          :execution-status="item.executionStatus"
          :result-usage="executionTree?.groups.value.byRoot.get(item.turn.runId)?.usage ?? null"
          :show-identity="item.showIdentity"
          :show-outcome="item.showOutcome"
          :turn="item.turn"
          @activate-branch="emit('activateBranch', $event)"
          @regenerate="emit('regenerateAssistant', item.turn.runId)"
          @followup="item.turn.finalMessageId && emit('followupAssistant', item.turn.finalMessageId, item.turn.branchId)"
        >
          <template #before-actions>
            <BuddyExecutionGroup
              v-if="executionAnchors.has(item.key)"
              :key="`${conversationId}:${activeBranchId}:${executionAnchors.get(item.key)}`"
              class="mt-[var(--buddy-chat-gap-section)]"
              :root-run-id="executionAnchors.get(item.key)!"
              :language="language"
            />
          </template>
        </BuddyChatAgentTurn>

        <BuddyChatRunActivity
          v-else-if="item.kind === 'activity'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :language="language"
          :turn="item.turn"
          :stopping="stoppingRunId === item.turn.runId"
          :execution-group="executionTree?.groups.value.byRoot.get(item.turn.runId)"
        />

        <div
          v-else-if="item.kind === 'recovery-notice'"
          :data-chat-row-key="item.key"
          class="buddy-chat-system-event buddy-chat-transcript-row is-warning"
          role="status"
        >
          <span>{{ recoveryNoticeLabel(item.notice) }}</span>
        </div>

        <BuddyChatAgentTurnFlow
          v-else-if="item.kind === 'activity-flow'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :nodes="item.nodes"
          :failure-detail-text="null"
          :language="language"
        />

        <BuddyChatCompactionRow
          v-else-if="item.kind === 'compaction'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :node="item.compaction"
          :language="language"
        />
        <BuddyExecutionGroup
          v-if="item.kind === 'activity' && executionAnchors.has(item.key)"
          :key="`${conversationId}:${activeBranchId}:${executionAnchors.get(item.key)}`"
          class="buddy-chat-transcript-row"
          :data-chat-row-key="`executions:${executionAnchors.get(item.key)}`"
          :root-run-id="executionAnchors.get(item.key)!"
          :language="language"
        />
      </template>
    </BuddyChatTranscriptViewport>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-message-list__history-status {
  transform: translateX(-50%);
}

.buddy-chat-transcript-row {
  box-sizing: border-box;
  width: min(
    calc(
      var(--buddy-chat-reading-width)
      + var(--buddy-chat-inline-gutter)
      + var(--buddy-chat-inline-gutter)
    ),
    100%
  );
  margin: 0 auto;
  padding-inline: var(--buddy-chat-inline-gutter);
}

.buddy-chat-agent-turn.buddy-chat-transcript-row {
  padding-bottom: var(--buddy-chat-gap-block);
}

.buddy-chat-message.buddy-chat-transcript-row {
  border-radius: var(--buddy-radius-micro);
  outline: 1px solid transparent;
  outline-offset: -1px;
  transition: outline-color 180ms ease-out;

  &.is-outline-highlighted {
    outline-color: var(--buddy-accent-border);
  }
}

.buddy-chat-day-divider {
  display: flex;
  justify-content: center;
  color: var(--buddy-text-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.25rem;
  padding-block: 0.75rem 1.25rem;
}

.buddy-chat-agent-turn.has-visible-process.buddy-chat-transcript-row {
  padding-bottom: var(--buddy-chat-gap-section);
}

.buddy-chat-agent-turn.buddy-chat-transcript-row.is-speech-end,
.buddy-chat-message.buddy-chat-transcript-row.is-speech-end {
  padding-bottom: var(--buddy-chat-gap-turn);
}

.buddy-chat-transcript-row:has(> .buddy-chat-execution-group):has(+ .buddy-chat-message.is-assistant:not(.is-assistant-continuation)),
.buddy-chat-transcript-row:has(> .buddy-chat-execution-group):has(+ .buddy-chat-agent-turn:not(.is-assistant-continuation)) {
  padding-bottom: 0;
}

.buddy-chat-system-event {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  padding-bottom: 1rem;

  &::before,
  &::after {
    width: min(4rem, 10vw);
    height: 1px;
    background: var(--buddy-border-subtle);
    content: '';
  }

  small {
    color: var(--buddy-text-muted);
    font-size: 0.65rem;
  }

  &.is-warning {
    color: var(--buddy-status-warning-text);

    &::before,
    &::after {
      background: var(--buddy-status-warning-border);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-message.buddy-chat-transcript-row {
    transition: none;
  }
}
</style>
