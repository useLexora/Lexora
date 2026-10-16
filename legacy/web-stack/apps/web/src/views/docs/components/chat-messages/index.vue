<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { DocsChatMessagesEmits, DocsChatMessagesProps } from './typing'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChatAssistantAvatar,
  ChatAssistantMessage,
  ChatMessageActions,
  ChatUserMessageContent,
} from '@/components/chat-message'
import { useDynamicChatVirtualList } from '@/composables/chat/useDynamicChatVirtualList'
import {
  getUserMessageDeliveryLabel,
  shouldShowAssistantPending,
  shouldShowUserMessageDelivery,
} from '@/composables/chat/utils/chat-message-display'

const props = withDefaults(defineProps<DocsChatMessagesProps>(), {
  isReadonly: false,
  isStreaming: false,
})
const emits = defineEmits<DocsChatMessagesEmits>()
const { t } = useI18n()

const scrollContainerRef = useTemplateRef<HTMLElement>('scrollContainerRef')
const hasMessages = computed(() => props.messages.length > 0)
const virtualListKey = computed(() => props.sessionId)
const virtualMessages = computed(() => props.messages)
const {
  handleScroll,
  setItemElement,
  spacerStyle,
  virtualItems,
} = useDynamicChatVirtualList({
  items: virtualMessages,
  listKey: virtualListKey,
  scrollContainerRef,
  estimateSize: 96,
  overscan: 8,
  bottomThreshold: 72,
  getItemKey: message => message.id,
})

function setVirtualItemElement(key: string, element: Element | ComponentPublicInstance | null) {
  setItemElement(key, element instanceof Element ? element : null)
}

function isCopied(message: DocsChatMessagesProps['messages'][number]) {
  return props.isMessageCopied?.(message) ?? false
}
</script>

<template>
  <div
    ref="scrollContainerRef"
    class="docs-chat-messages min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-4"
    :data-message-count="props.messages.length"
    @scroll="handleScroll"
  >
    <div v-if="!hasMessages" class="flex min-h-48 flex-col justify-center text-center text-secondary">
      <div class="text-[0.95rem] font-semibold leading-6 text-main">
        {{ t('docs.chat.emptyTitle') }}
      </div>
      <div class="mt-1 text-[13px] leading-[1.35rem]">
        {{ t('docs.chat.emptyDescription') }}
      </div>
    </div>

    <div
      v-else
      class="docs-chat-messages__virtual-space"
      :style="spacerStyle"
    >
      <div
        v-for="virtual in virtualItems"
        :key="virtual.key"
        :ref="element => setVirtualItemElement(virtual.key, element)"
        class="docs-chat-messages__virtual-item"
        :style="virtual.style"
      >
        <div
          class="docs-chat-messages__item flex min-w-0 w-full"
          :class="virtual.item.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            v-if="virtual.item.role === 'user'"
            class="docs-chat-messages__user-content flex min-w-0 flex-col items-end gap-1.5"
          >
            <div class="docs-chat-messages__user-bubble max-w-full break-words rounded-lg bg-primary px-3 py-2 text-[13px] leading-[1.55] text-white">
              <ChatUserMessageContent :message="virtual.item" />
            </div>
            <div
              v-if="shouldShowUserMessageDelivery(virtual.item)"
              class="docs-chat-messages__user-delivery text-xs leading-4"
              :class="virtual.item.status === 'failed' ? 'is-failed' : 'is-pending'"
            >
              {{ getUserMessageDeliveryLabel(virtual.item) }}
            </div>

            <ChatMessageActions
              v-if="!shouldShowUserMessageDelivery(virtual.item)"
              class="docs-chat-messages__actions user flex items-center justify-end gap-1"
              :message="virtual.item"
              :copied="isCopied(virtual.item)"
              :is-streaming="props.isStreaming"
              :is-readonly="props.isReadonly"
              variant="docs"
              @copy-message="emits('copyMessage', $event)"
              @switch-branch="emits('switchBranch', $event)"
            />
          </div>

          <div v-else class="docs-chat-messages__assistant-row flex min-w-0 w-full items-start gap-2">
            <ChatAssistantAvatar
              :pending="shouldShowAssistantPending(virtual.item)"
              size="sm"
              class="mt-0.5 shrink-0"
            />
            <div class="docs-chat-messages__assistant-content flex min-w-0 flex-1 flex-col items-start gap-1.5">
              <ChatAssistantMessage :message="virtual.item" variant="docs" />

              <ChatMessageActions
                class="docs-chat-messages__actions assistant flex items-center justify-start gap-1"
                :message="virtual.item"
                :copied="isCopied(virtual.item)"
                :is-streaming="props.isStreaming"
                :is-readonly="props.isReadonly"
                show-retry
                variant="docs"
                @copy-message="emits('copyMessage', $event)"
                @retry-assistant-message="emits('retryAssistantMessage', $event)"
                @switch-branch="emits('switchBranch', $event)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.docs-chat-messages {
  --docs-chat-message-max-inline-size: min(30rem, 100%);

  overflow-anchor: none;
}

.docs-chat-messages__user-content {
  max-inline-size: var(--docs-chat-message-max-inline-size);
}

.docs-chat-messages__user-bubble {
  min-inline-size: 0;
}

.docs-chat-messages__user-delivery {
  color: var(--brand-text-tertiary);

  &.is-failed {
    color: var(--el-color-danger);
  }
}

.docs-chat-messages__virtual-item {
  box-sizing: border-box;
  padding-bottom: 0.875rem;
}

.docs-chat-messages__actions {
  color: var(--brand-text-tertiary);
}
</style>
