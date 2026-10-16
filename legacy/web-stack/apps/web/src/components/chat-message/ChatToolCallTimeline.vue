<script setup lang="ts">
import type { ChatToolCallTimelineProps } from './typing'
import type { AssistantToolCallView } from '@/composables/chat/utils/chat-message-display'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<ChatToolCallTimelineProps>()

const { t } = useI18n({ useScope: 'global' })
const summary = computed(() => {
  const total = props.items.length
  const failed = props.items.filter(item => item.status === 'error').length
  const pending = props.items.filter(item =>
    item.status === 'running'
    || item.status === 'input_streaming'
    || item.status === 'input_available',
  ).length
  const requiresAction = props.items.filter(item =>
    item.status === 'pending_confirmation'
    || item.status === 'requires_action',
  ).length
  const success = props.items.filter(item => item.status === 'success').length

  return [
    t('chat.messageDisplay.toolSummaryTotal', { count: total }),
    pending > 0 ? t('chat.messageDisplay.toolSummaryPending', { count: pending }) : null,
    requiresAction > 0 ? t('chat.messageDisplay.toolSummaryRequiresAction', { count: requiresAction }) : null,
    success > 0 ? t('chat.messageDisplay.toolSummarySuccess', { count: success }) : null,
    failed > 0 ? t('chat.messageDisplay.toolSummaryFailed', { count: failed }) : null,
  ].filter(Boolean).join(' · ')
})

function getStatusLabel(status: AssistantToolCallView['status']): string {
  if (status === 'input_streaming') {
    return t('chat.messageDisplay.inputStreaming')
  }

  if (status === 'input_available') {
    return t('chat.messageDisplay.inputAvailable')
  }

  if (status === 'success') {
    return t('chat.messageDisplay.success')
  }

  if (status === 'error') {
    return t('chat.messageDisplay.toolFailed')
  }

  if (status === 'pending_confirmation' || status === 'requires_action') {
    return t('chat.messageDisplay.toolPendingConfirmation')
  }

  return t('chat.messageDisplay.running')
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return ''
  }

  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`
}
</script>

<template>
  <details v-if="props.items.length > 0" class="chat-tool-call-timeline">
    <summary class="chat-tool-call-timeline__summary">
      <span class="chat-tool-call-timeline__summary-title">{{ t('chat.messageDisplay.toolActivity') }}</span>
      <span class="chat-tool-call-timeline__summary-text">{{ summary }}</span>
    </summary>

    <div class="chat-tool-call-timeline__body">
      <div
        v-for="item in props.items"
        :key="item.id"
        class="chat-tool-call-timeline__item"
        :class="`chat-tool-call-timeline__item--${item.status}`"
      >
        <div class="chat-tool-call-timeline__item-header">
          <span class="chat-tool-call-timeline__name">{{ item.displayTitle }}</span>
          <span class="chat-tool-call-timeline__status">{{ getStatusLabel(item.status) }}</span>
          <span v-if="formatDuration(item.durationMs)" class="chat-tool-call-timeline__duration">
            {{ formatDuration(item.durationMs) }}
          </span>
        </div>

        <div v-if="item.displayDetails.length > 0" class="chat-tool-call-timeline__details">
          <div
            v-for="detail in item.displayDetails"
            :key="detail"
            class="chat-tool-call-timeline__detail"
          >
            {{ detail }}
          </div>
        </div>
      </div>
    </div>
  </details>
</template>

<style scoped lang="scss">
.chat-tool-call-timeline {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 64%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-light) 22%, transparent);
}

.chat-tool-call-timeline__summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.375rem 0.5rem;
  cursor: pointer;
  color: var(--brand-text-secondary);
  font-size: 0.75rem;
  line-height: 1.4;
  list-style: none;

  &::-webkit-details-marker {
    display: none;
  }
}

.chat-tool-call-timeline__summary-title {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--brand-text-primary);
}

.chat-tool-call-timeline__summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-tool-call-timeline__body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0 0.5rem 0.5rem;
}

.chat-tool-call-timeline__item {
  border-left: 2px solid color-mix(in srgb, var(--brand-primary) 54%, transparent);
  padding-left: 0.5rem;
}

.chat-tool-call-timeline__item--success {
  border-left-color: var(--el-color-success);
}

.chat-tool-call-timeline__item--error {
  border-left-color: var(--el-color-danger);
}

.chat-tool-call-timeline__item-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  color: var(--brand-text-secondary);
  font-size: 0.75rem;
  line-height: 1.45;
}

.chat-tool-call-timeline__status {
  flex-shrink: 0;
  border-radius: 0.25rem;
  padding: 0.0625rem 0.25rem;
  background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
  color: var(--brand-text-secondary);
  font-weight: 600;
}

.chat-tool-call-timeline__name {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--brand-text-primary);
  font-weight: 600;
}

.chat-tool-call-timeline__duration {
  color: var(--brand-text-tertiary);
}

.chat-tool-call-timeline__details {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  margin-top: 0.25rem;
}

.chat-tool-call-timeline__detail {
  color: var(--brand-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
