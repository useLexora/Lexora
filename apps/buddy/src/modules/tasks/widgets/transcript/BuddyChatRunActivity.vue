<script setup lang="ts">
import type { ChatAgentTurn } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Clock20Regular } from '@vicons/fluent'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { describeChatCurrentActivity } from '../../model/transcript/chatCurrentActivity'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import BuddyChatActivityStatus from './BuddyChatActivityStatus.vue'

const props = defineProps<{
  language: BuddyLocale
  turn: ChatAgentTurn
  stopping?: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const now = shallowRef(Date.now())
const activity = computed(() => describeChatCurrentActivity(props.turn, props.language, now.value, props.stopping))
useIntervalFn(() => {
  now.value = Date.now()
}, 1_000, { immediateCallback: true })
const duration = computed(() => formatChatRunDuration(props.turn.startedAt, props.turn.completedAt, now.value))
</script>

<template>
  <div v-if="activity" class="buddy-chat-run-activity min-w-0 pb-[var(--buddy-chat-gap-turn)]" :class="{ 'is-retrying': activity.retry }">
    <BuddyChatActivityStatus :label="activity.label" :warning="activity.warning" :active="activity.active">
      <template #icon>
        <DesktopIcon :component="Clock20Regular" class="buddy-chat-run-activity__waiting" aria-hidden="true" />
      </template>
      <span v-if="activity.retry" class="buddy-chat-run-activity__retry-meta gap-[10px] text-muted">
        <span class="buddy-chat-run-activity__retry-attempt gap-[4px]">
          <span>{{ t('desktop.chat.retryAttempt', { attempt: activity.retry.attempt }) }}</span>
          <span class="text-muted">/</span>
          <DesktopIcon v-if="activity.retry.maxAttempts === 'unlimited'" class="buddy-chat-run-activity__unlimited" :size="16" role="img" :aria-label="t('desktop.chat.retryUnlimited')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 12C9.5 8.5 8 7.5 6 7.5a4.5 4.5 0 0 0 0 9c2 0 3.5-1 6-4.5s4-4.5 6-4.5a4.5 4.5 0 0 1 0 9c-2 0-3.5-1-6-4.5Z" />
            </svg>
          </DesktopIcon>
          <span v-else>{{ activity.retry.maxAttempts }}</span>
        </span>
        <span class="w-[1px] h-[12px] bg-border-strong" aria-hidden="true" />
        <span class="buddy-chat-run-activity__duration flex-none text-muted whitespace-nowrap" aria-live="off">{{ t('desktop.chat.retryElapsed', { duration }) }}</span>
      </span>
      <span v-else class="buddy-chat-run-activity__duration flex-none text-muted whitespace-nowrap" aria-live="off">{{ duration }}</span>
    </BuddyChatActivityStatus>
  </div>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

.buddy-chat-run-activity__waiting { @include activity.icon; }

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
  font-size: var(--buddy-chat-tool-font-size);
  font-variant-numeric: tabular-nums;
}
</style>
