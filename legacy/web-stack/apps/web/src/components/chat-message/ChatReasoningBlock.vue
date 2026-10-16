<script setup lang="ts">
import type { ChatReasoningBlockProps } from './typing'
import { ArrowDown } from '@element-plus/icons-vue'
import { CHAT_MESSAGE_STATUS } from '@haohaoxue/lexora-contracts/chat/constants'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStreamingTextReveal } from '@/composables/chat/useStreamingTextReveal'

const props = withDefaults(defineProps<ChatReasoningBlockProps>(), {
  answerStarted: false,
  elapsedMs: null,
  defaultExpanded: false,
})

const { t } = useI18n({ useScope: 'global' })
const isExpanded = ref(props.defaultExpanded)
const isStreaming = computed(() => props.status === CHAT_MESSAGE_STATUS.STREAMING)
const shouldAnimateText = computed(() => isStreaming.value && !props.answerStarted)
const { visibleText } = useStreamingTextReveal({
  animate: shouldAnimateText,
  identity: () => props.messageId,
  maxGraphemesPerFrame: 8,
  source: () => props.text,
})
const elapsedSeconds = computed(() => props.elapsedMs ? Math.max(1, Math.round(props.elapsedMs / 1000)) : null)
const summaryText = computed(() => {
  if (props.status === CHAT_MESSAGE_STATUS.STREAMING) {
    return t('chat.messageDisplay.pendingThinking')
  }

  if (props.status === CHAT_MESSAGE_STATUS.FAILED) {
    return t('chat.messageDisplay.interruptedThinking')
  }

  return elapsedSeconds.value
    ? t('chat.messageDisplay.thinkingSeconds', { seconds: elapsedSeconds.value })
    : t('chat.messageDisplay.thinkingDone')
})

watch(
  () => props.defaultExpanded,
  (nextDefaultExpanded) => {
    isExpanded.value = nextDefaultExpanded
  },
)
</script>

<template>
  <section class="chat-reasoning-block">
    <button
      type="button"
      class="chat-reasoning-block__toggle"
      :aria-expanded="isExpanded"
      @click="isExpanded = !isExpanded"
    >
      <ArrowDown class="chat-reasoning-block__chevron" :class="{ expanded: isExpanded }" />
      <span>{{ summaryText }}</span>
    </button>

    <div v-if="isExpanded" class="chat-reasoning-block__body">
      {{ visibleText }}
    </div>
  </section>
</template>

<style scoped lang="scss">
.chat-reasoning-block {
  max-width: 100%;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.55;

  .chat-reasoning-block__toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-height: 1.625rem;
    padding: 0;
    color: var(--brand-text-secondary);
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  .chat-reasoning-block__chevron {
    width: 0.875rem;
    height: 0.875rem;
    transition: transform 160ms ease;

    &.expanded {
      transform: rotate(180deg);
    }
  }

  .chat-reasoning-block__body {
    margin-top: 0.3125rem;
    padding-left: 0.625rem;
    border-left: 2px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
