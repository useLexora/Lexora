<script setup lang="ts">
import type { ChatToolResultBlockProps } from './typing'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatMarkdownContent } from '@/components/chat-markdown'

const props = defineProps<ChatToolResultBlockProps>()
const TOOL_RESULT_BUDGET_THRESHOLD = 40_000
const TOOL_RESULT_INITIAL_VISIBLE_CHARS = 12_000
const TOOL_RESULT_INCREMENT_CHARS = 20_000

const { t } = useI18n({ useScope: 'global' })
const actionName = computed(() => props.part.metadata?.actionName ?? t('chat.messageDisplay.toolResultFallback'))
const summary = computed(() => getToolResultSummary(props.part.text))
const hasMountedBody = shallowRef(false)
const visibleCharLimit = shallowRef(TOOL_RESULT_INITIAL_VISIBLE_CHARS)
const isBudgetMode = computed(() => props.part.text.length >= TOOL_RESULT_BUDGET_THRESHOLD)
const visibleSource = computed(() => {
  if (!isBudgetMode.value) {
    return props.part.text
  }

  return sliceToolResultSource(props.part.text, visibleCharLimit.value)
})
const hasHiddenSource = computed(() => isBudgetMode.value && visibleSource.value.length < props.part.text.length)

function handleToggle(event: Event): void {
  if ((event.currentTarget as HTMLDetailsElement | null)?.open) {
    hasMountedBody.value = true
  }
}

function showMoreSource(): void {
  visibleCharLimit.value = Math.min(
    props.part.text.length,
    visibleCharLimit.value + TOOL_RESULT_INCREMENT_CHARS,
  )
}

function showAllSource(): void {
  visibleCharLimit.value = props.part.text.length
}

function getToolResultSummary(text: string): string {
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? t('chat.messageDisplay.toolResultNoContent')
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine
}

function sliceToolResultSource(source: string, maxChars: number): string {
  if (source.length <= maxChars) {
    return source
  }

  const lineBreakIndex = source.lastIndexOf('\n', maxChars)
  const minStableSlice = Math.floor(maxChars * 0.6)

  return source.slice(0, lineBreakIndex > minStableSlice ? lineBreakIndex : maxChars)
}
</script>

<template>
  <details class="chat-tool-result-block" @toggle="handleToggle">
    <summary class="chat-tool-result-block__summary">
      <span class="chat-tool-result-block__index">{{ t('chat.messageDisplay.resultTitle', { index: props.index + 1 }) }}</span>
      <span class="chat-tool-result-block__name">{{ actionName }}</span>
      <span class="chat-tool-result-block__text">{{ summary }}</span>
    </summary>
    <div
      v-if="hasMountedBody"
      class="chat-tool-result-block__body"
    >
      <ChatMarkdownContent
        :message-id="props.messageId"
        :part-id="props.part.id"
        :source="visibleSource"
        :phase="props.phase"
      />
      <div v-if="hasHiddenSource" class="chat-tool-result-block__controls flex flex-wrap items-center gap-2 pt-2">
        <ElButton
          size="small"
          type="primary"
          text
          data-testid="tool-result-show-more"
          @click="showMoreSource"
        >
          {{ t('chat.messageDisplay.showMore') }}
        </ElButton>
        <ElButton
          size="small"
          text
          data-testid="tool-result-show-all"
          @click="showAllSource"
        >
          {{ t('chat.messageDisplay.showAll') }}
        </ElButton>
      </div>
    </div>
  </details>
</template>

<style scoped lang="scss">
.chat-tool-result-block {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 56%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-light) 28%, transparent);

  .chat-tool-result-block__summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.375rem 0.5rem;
    color: var(--brand-text-secondary);
    cursor: pointer;
    font-size: 0.8125rem;
    line-height: 1.5;
    list-style: none;

    &::-webkit-details-marker {
      display: none;
    }
  }

  .chat-tool-result-block__index,
  .chat-tool-result-block__name {
    flex-shrink: 0;
    font-weight: 600;
  }

  .chat-tool-result-block__name {
    color: var(--brand-text-primary);
  }

  .chat-tool-result-block__text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-tool-result-block__body {
    padding: 0 0.5rem 0.5rem;
  }
}
</style>
