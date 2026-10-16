<script setup lang="ts">
import type { ChatAssistantMessageProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatMarkdownContent } from '@/components/chat-markdown'
import { createAssistantMessageDisplayModel } from '@/composables/chat/utils/chat-message-display'
import ChatReasoningBlock from './ChatReasoningBlock.vue'
import ChatToolCallTimeline from './ChatToolCallTimeline.vue'
import ChatToolResultBlock from './ChatToolResultBlock.vue'

const props = withDefaults(defineProps<ChatAssistantMessageProps>(), {
  variant: 'global',
  showUsageSummary: true,
})

const { locale, t } = useI18n({ useScope: 'global' })
const display = computed(() => {
  readReactiveLocale(locale.value)
  return createAssistantMessageDisplayModel(props.message)
})
const answerStarted = computed(() => Boolean(display.value.messageText))

function readReactiveLocale(value: string): string {
  return value
}
</script>

<template>
  <div class="chat-assistant-message" :class="`chat-assistant-message--${props.variant}`">
    <ChatReasoningBlock
      v-if="display.reasoningText"
      :message-id="props.message.id"
      :text="display.reasoningText"
      :status="props.message.status"
      :elapsed-ms="display.reasoningElapsedMs"
      :default-expanded="display.isStreaming && !answerStarted"
      :answer-started="answerStarted"
    />

    <div v-if="display.messageText" class="chat-assistant-message__bubble">
      <ChatMarkdownContent
        :message-id="props.message.id"
        :part-id="display.messageTextPartId"
        :source="display.messageText"
        :phase="display.markdownPhase"
      />
    </div>

    <ChatToolCallTimeline :items="display.toolCallViews" />

    <ElTooltip
      v-if="props.showUsageSummary && display.usageSummary"
      :content="display.usageTooltip"
      placement="top"
      effect="light"
    >
      <div class="chat-assistant-message__usage">
        {{ display.usageSummary }}
      </div>
    </ElTooltip>

    <div
      v-else-if="display.showPending"
      class="chat-assistant-message__pending"
      aria-live="polite"
    >
      <span class="chat-assistant-message__pending-status">
        <span class="chat-assistant-message__pending-label">{{ t('chat.messageDisplay.pendingThinking') }}</span>
        <span class="chat-assistant-message__thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </span>
      <span class="chat-assistant-message__thinking-wave" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
    </div>

    <div v-if="display.failureMessage" class="chat-assistant-message__error">
      {{ display.failureMessage }}
    </div>

    <div v-if="display.showCancelled" class="chat-assistant-message__cancelled">
      {{ t('chat.messageDisplay.stopped') }}
    </div>

    <ChatToolResultBlock
      v-for="(part, index) in display.toolResultParts"
      :key="part.id"
      :message-id="props.message.id"
      :part="part"
      :index="index"
      phase="final"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-assistant-message {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;

  &.chat-assistant-message--docs {
    gap: 0.375rem;
    inline-size: 100%;
    max-width: 100%;
  }
}

.chat-assistant-message__bubble {
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  overflow-wrap: break-word;
  color: var(--brand-text-primary);
  background: color-mix(in srgb, var(--brand-bg-surface) 94%, var(--brand-fill-light));
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  font-size: 0.875rem;
  line-height: 1.6;

  .chat-assistant-message--docs & {
    inline-size: fit-content;
    max-inline-size: var(--docs-chat-message-max-inline-size, min(30rem, 100%));
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    line-height: 1.5;
  }
}

.chat-assistant-message__pending,
.chat-assistant-message__error,
.chat-assistant-message__cancelled {
  font-size: 0.8125rem;
  line-height: 1.5;
}

.chat-assistant-message__usage {
  width: fit-content;
  font-size: 0.75rem;
  line-height: 1.25;
  color: var(--brand-text-tertiary);

  .chat-assistant-message--docs & {
    font-size: 0.71875rem;
  }
}

.chat-assistant-message__pending,
.chat-assistant-message__cancelled {
  color: var(--brand-text-secondary);
}

.chat-assistant-message__pending {
  display: inline-flex;
  width: fit-content;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.0625rem;
  min-height: 1.875rem;

  .chat-assistant-message--docs & {
    gap: 0;
    min-height: 1.6875rem;
  }
}

.chat-assistant-message__pending-status {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.chat-assistant-message__pending-label {
  font-weight: 500;
  color: color-mix(in srgb, var(--brand-text-secondary) 88%, var(--brand-text-primary));
}

.chat-assistant-message__thinking-dots {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
  width: 1rem;

  span {
    width: 0.21875rem;
    height: 0.21875rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--brand-primary) 82%, var(--brand-text-secondary));
    opacity: 0.35;
    transform: translateY(0);
    animation: chat-assistant-message-dot 1.24s ease-in-out infinite;

    &:nth-child(2) {
      background: color-mix(in srgb, var(--brand-primary) 62%, var(--brand-warning));
      animation-delay: 0.14s;
    }

    &:nth-child(3) {
      animation-delay: 0.28s;
    }
  }
}

.chat-assistant-message__thinking-wave {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  height: 0.625rem;
  margin-left: 0.0625rem;

  .chat-assistant-message--docs & {
    height: 0.5625rem;
  }

  span {
    width: 0.125rem;
    height: 0.375rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--brand-primary) 58%, transparent);
    transform-origin: center;
    animation: chat-assistant-message-wave 1.08s ease-in-out infinite;

    &:nth-child(2) {
      height: 0.625rem;
      background: color-mix(in srgb, var(--brand-primary) 74%, transparent);
      animation-delay: 0.12s;
    }

    &:nth-child(3) {
      height: 0.5rem;
      background: color-mix(in srgb, var(--brand-warning) 54%, var(--brand-primary));
      animation-delay: 0.24s;
    }

    &:nth-child(4) {
      height: 0.3125rem;
      animation-delay: 0.36s;
    }
  }
}

.chat-assistant-message__error {
  color: var(--el-color-danger);
}

@keyframes chat-assistant-message-dot {
  0%,
  68%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }

  34% {
    opacity: 0.9;
    transform: translateY(-0.1875rem);
  }
}

@keyframes chat-assistant-message-wave {
  0%,
  100% {
    opacity: 0.45;
    transform: scaleY(0.72);
  }

  50% {
    opacity: 0.95;
    transform: scaleY(1.16);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-assistant-message__thinking-dots span,
  .chat-assistant-message__thinking-wave span {
    animation: none;
  }
}
</style>
