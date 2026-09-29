<script setup lang="ts">
import type { ChatAgentTurn } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular } from '@vicons/fluent'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { describeChatCurrentActivity } from '../../model/transcript/chatCurrentActivity'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import BuddyChatActivityStatus from './BuddyChatActivityStatus.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'
import BuddyChatReasoningBody from './BuddyChatReasoningBody.vue'

const props = defineProps<{
  language: BuddyLocale
  turn: ChatAgentTurn
}>()
const emit = defineEmits<{ revealActivity: [nodeId: string] }>()
const { t } = useBuddyI18n(() => props.language)
const now = shallowRef(Date.now())
const expandedReasoningId = shallowRef<string | null>(null)
const revealedToolId = shallowRef<string | null>(null)
const activity = computed(() => describeChatCurrentActivity(props.turn, props.language, now.value))
const reasoningOpen = computed(() => activity.value?.reasoning != null && expandedReasoningId.value === activity.value.reasoning.id)
useIntervalFn(() => {
  now.value = Date.now()
}, 1_000, { immediateCallback: true })
const duration = computed(() => formatChatRunDuration(props.turn.startedAt, props.turn.completedAt, now.value))
const actionLabel = computed(() => t(activity.value?.reasoning
  ? 'desktop.chat.activityViewReasoning'
  : (activity.value?.tools.length ?? 0) > 1 ? 'desktop.chat.activityNextCall' : 'desktop.chat.activityViewCall'))

function reveal() {
  const current = activity.value
  if (current?.reasoning) {
    expandedReasoningId.value = reasoningOpen.value ? null : current.reasoning.id
    return
  }
  if (!current?.tools.length)
    return
  const index = current.tools.findIndex(node => node.id === revealedToolId.value)
  const node = current.tools[(index + 1) % current.tools.length]!
  revealedToolId.value = node.id
  emit('revealActivity', node.id)
}
</script>

<template>
  <div v-if="activity" class="buddy-chat-run-activity" :class="{ 'is-retrying': activity.retry }">
    <BuddyChatActivityStatus :label="activity.label" :target="reasoningOpen ? '' : activity.target" :detail="activity.detail" :warning="!!activity.retry" active>
      <span v-if="activity.retry" class="buddy-chat-run-activity__retry-meta">
        <span class="buddy-chat-run-activity__retry-attempt">
          <span>{{ t('desktop.chat.retryAttempt', { attempt: activity.retry.attempt }) }}</span>
          <span class="buddy-chat-run-activity__retry-slash">/</span>
          <DesktopIcon v-if="activity.retry.maxAttempts === 'unlimited'" class="buddy-chat-run-activity__unlimited" :size="16" role="img" :aria-label="t('desktop.chat.retryUnlimited')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 12C9.5 8.5 8 7.5 6 7.5a4.5 4.5 0 0 0 0 9c2 0 3.5-1 6-4.5s4-4.5 6-4.5a4.5 4.5 0 0 1 0 9c-2 0-3.5-1-6-4.5Z" />
            </svg>
          </DesktopIcon>
          <span v-else>{{ activity.retry.maxAttempts }}</span>
        </span>
        <span class="buddy-chat-run-activity__retry-separator" aria-hidden="true" />
        <span class="buddy-chat-run-activity__duration" aria-live="off">{{ t('desktop.chat.retryElapsed', { duration }) }}</span>
      </span>
      <template v-else>
        <button
          v-if="activity.reasoning || activity.tools.length"
          class="buddy-chat-run-activity__reveal" :class="{ 'is-open': reasoningOpen }" type="button"
          :aria-label="actionLabel" :aria-expanded="activity.reasoning ? reasoningOpen : undefined"
          @click="reveal"
        >
          <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" aria-hidden="true" />
        </button>
        <span class="buddy-chat-run-activity__duration" aria-live="off">{{ duration }}</span>
      </template>
    </BuddyChatActivityStatus>
    <BuddyChatDisclosure>
      <BuddyChatReasoningBody v-if="reasoningOpen && activity.reasoning" :key="activity.reasoning.id" :text="activity.reasoning.text" class="buddy-chat-run-activity__reasoning" />
    </BuddyChatDisclosure>
  </div>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

.buddy-chat-activity-row__chevron { @include activity.chevron; }

.buddy-chat-run-activity {
  min-width: 0;
  padding-bottom: var(--buddy-chat-gap-turn);
}

.buddy-chat-run-activity.is-retrying {
  container-type: inline-size;
}

.buddy-chat-run-activity.is-retrying :deep(.buddy-chat-activity-status) {
  display: grid;
  grid-template-columns: var(--buddy-chat-activity-icon-size) max-content minmax(0, 1fr);
  column-gap: 8px;
  font-family: var(--buddy-font-ui);
  font-variant-numeric: tabular-nums;
}

.buddy-chat-run-activity.is-retrying :deep(.buddy-chat-activity-status__label) {
  max-width: none;
}

.buddy-chat-run-activity__retry-meta,
.buddy-chat-run-activity__retry-attempt {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.buddy-chat-run-activity__retry-meta {
  gap: 10px;
  color: var(--buddy-text-secondary);
}

.buddy-chat-run-activity__retry-attempt {
  gap: 4px;
}

.buddy-chat-run-activity__retry-slash {
  color: var(--buddy-text-muted);
}

.buddy-chat-run-activity__retry-separator {
  width: 1px;
  height: 12px;
  background: var(--buddy-border-strong);
}

.buddy-chat-run-activity__retry-meta .buddy-chat-run-activity__duration {
  color: inherit;
  font: inherit;
}

@container (max-width: 420px) {
  .buddy-chat-run-activity.is-retrying :deep(.buddy-chat-activity-status) {
    grid-template-columns: var(--buddy-chat-activity-icon-size) minmax(0, 1fr);
  }

  .buddy-chat-run-activity__retry-meta {
    grid-column: 2;
  }
}

.buddy-chat-run-activity__duration {
  min-width: 3.5ch;
  flex: none;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.buddy-chat-run-activity__reveal {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  padding: 4px;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-text-muted);
  cursor: pointer;

  &.is-open :deep(.n-icon) { transform: rotate(90deg); }
  &:hover { background: var(--buddy-state-hover); color: var(--buddy-text-secondary); }
  &:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 2px; }
}

.buddy-chat-run-activity__reasoning { margin-top: 4px; padding-inline-start: var(--buddy-chat-activity-indent); }
</style>
