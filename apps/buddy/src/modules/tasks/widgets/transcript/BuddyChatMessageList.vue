<script setup lang="ts">
import type { DesktopChatOutlinePosition } from '@buddy-electron/shared/desktopApi'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'

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
import { NSpin } from 'naive-ui'
import { onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import {
  formatChatDayDividerLabel,
} from '../../model/transcript/chatMessageTime'
import BuddyChatAgentTurn from './BuddyChatAgentTurn.vue'
import BuddyChatCompactionRow from './BuddyChatCompactionRow.vue'
import BuddyChatMessageRow from './BuddyChatMessageRow.vue'
import BuddyChatOutline from './BuddyChatOutline.vue'
import BuddyChatRunActivity from './BuddyChatRunActivity.vue'
import BuddyChatTranscriptViewport from './BuddyChatTranscriptViewport.vue'
import { useChatActivityNavigation } from './useChatActivityNavigation'

const props = defineProps<{
  activeBranchId: string
  actionsDisabled?: boolean
  branchNavigators: ReadonlyMap<string, ChatMessageBranchNavigator>
  conversationId: string
  displayRows: ReadonlyArray<ChatTranscriptDisplayRow>
  editingMessageId?: string | null
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  language: BuddyLocale
  outlineItems: ReadonlyArray<ChatOutlineItem>
  outlineLoading: boolean
  outlinePosition: DesktopChatOutlinePosition
  showReturnToLatest?: boolean
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  editUserMessage: [messageId: string]
  openArtifact: [artifactId: string]
  openChanges: [changeSetId: string]
  prepareOutline: []
  readerLayoutIntent: []
  regenerateAssistant: [sourceRunId: string]
  returnToLatest: []
  selectOutlineMessage: [messageId: string]
  scroll: [metrics: ChatMessageScrollMetrics]
  contentResize: [metrics: ChatMessageScrollMetrics]
}>()

const { t } = useBuddyI18n(() => props.language)
const activityNavigation = useChatActivityNavigation()
const transcriptViewport = useTemplateRef<BuddyChatTranscriptViewportHandle>('transcriptViewport')
const OUTLINE_HIGHLIGHT_DURATION_MS = 1_200
const activeOutlineMessageId = shallowRef<string | null>(null)
const highlightedOutlineMessageId = shallowRef<string | null>(null)
let outlineHighlightTimer: number | null = null
watch([() => props.conversationId, () => props.activeBranchId], () => {
  activeOutlineMessageId.value = null
  clearOutlineHighlight()
})

function regenerateMessage(message: LocalMessage) {
  if (message.runId)
    emit('regenerateAssistant', message.runId)
}

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
  return transcriptViewport.value?.scrollToMessage(messageId, behavior) ?? null
}

function highlightMessage(messageId: string) {
  clearOutlineHighlight()
  highlightedOutlineMessageId.value = messageId
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
    class="buddy-chat-message-list"
    role="log"
    @click.capture="handleReaderLayoutIntent"
  >
    <div
      v-if="isLoadingOlderMessages"
      class="buddy-chat-message-list__history-status"
      role="status"
    >
      <NSpin :size="14" />
      <span>{{ t('desktop.chat.loadingOlder') }}</span>
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
      @return-to-latest="emit('returnToLatest')"
      @scroll="emit('scroll', $event)"
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
          :branch-navigator="branchNavigators.get(item.message.id) ?? null"
          class="buddy-chat-transcript-row" :class="[
            { 'is-outline-highlighted': item.message.id === highlightedOutlineMessageId },
          ]"
          :is-intermediate="item.isIntermediate"
          :show-identity="item.showIdentity"
          :result-run-id="item.resultRunId"
          :editing="item.message.id === editingMessageId"
          :language="language"
          :message="item.message"
          :streaming="item.streaming === true"
          :turn-outputs="item.turnOutputs"
          :turn-changes="item.turnChanges"
          :turn-usage="item.turnUsage"
          @activate-branch="emit('activateBranch', $event)"
          @open-artifact="emit('openArtifact', $event)"
          @open-changes="emit('openChanges', $event)"
          @regenerate="regenerateMessage(item.message)"
          @start-edit="emit('editUserMessage', item.message.id)"
        />

        <BuddyChatAgentTurn
          v-else-if="item.kind === 'agent-turn'"
          :ref="view => activityNavigation.register(item.key, view, item.turn.nodes.map(node => node.id))"
          :data-chat-row-key="item.key"
          :actions-disabled="actionsDisabled ?? false"
          :branch-navigator="branchNavigators.get(item.turn.runId) ?? null"
          class="buddy-chat-transcript-row"
          :language="language"
          :owns-result-actions="item.ownsResultActions === true"
          :show-identity="item.showIdentity"
          :show-outcome="item.showOutcome"
          :turn="item.turn"
          @activate-branch="emit('activateBranch', $event)"
          @regenerate="emit('regenerateAssistant', item.turn.runId)"
        />

        <BuddyChatRunActivity
          v-else-if="item.kind === 'activity'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :language="language"
          :turn="item.turn"
          @reveal-activity="activityNavigation.reveal(item.turn.runId, $event)"
        />

        <div
          v-else-if="item.kind === 'recovery-notice'"
          :data-chat-row-key="item.key"
          class="buddy-chat-system-event buddy-chat-transcript-row is-warning"
          role="status"
        >
          <span>{{ recoveryNoticeLabel(item.notice) }}</span>
        </div>

        <BuddyChatCompactionRow
          v-else-if="item.kind === 'compaction'"
          :data-chat-row-key="item.key"
          class="buddy-chat-transcript-row"
          :node="item.compaction"
          :language="language"
        />
      </template>
    </BuddyChatTranscriptViewport>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-message-list {
  position: relative;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.buddy-chat-message-list__history-status {
  position: absolute;
  z-index: 2;
  top: 0.45rem;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: var(--buddy-radius-micro);
  background: var(--buddy-surface-raised);
  color: var(--buddy-text-secondary);
  font-size: 0.68rem;
  padding: 0.25rem 0.6rem;
  pointer-events: none;
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
