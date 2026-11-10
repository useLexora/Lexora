<script setup lang="ts">
import type { ChatTranscriptDisplayRow } from '../../model/transcript/chatMessageTime'
import type {
  BuddyChatTranscriptViewportHandle,
  ChatMessageScrollMetrics,
} from './chatMessageViewport'
import { useTemplateRef } from 'vue'
import BuddyChatReturnToLatest from './BuddyChatReturnToLatest.vue'
import BuddyChatVirtualRow from './BuddyChatVirtualRow.vue'
import { useChatTranscriptViewport } from './useChatTranscriptViewport'

const props = defineProps<{
  rows: readonly ChatTranscriptDisplayRow[]
  editingMessageId?: string | null
  hasOlderMessages: boolean
  hasTail?: boolean
  returnToLatestLabel: string
  showReturnToLatest: boolean
}>()

const emit = defineEmits<{
  activeMessageChange: [messageId: string | null]
  contentResize: [metrics: ChatMessageScrollMetrics]
  readerScrollIntent: []
  returnToLatest: []
  scroll: [metrics: ChatMessageScrollMetrics, options?: { userInitiated?: boolean }]
}>()

const root = useTemplateRef<HTMLElement>('root')
const content = useTemplateRef<HTMLElement>('content')
const { handle, handleScroll, measureRow, virtualRows, totalHeight, tailOffset } = useChatTranscriptViewport(root, content, {
  rows: () => props.rows,
  editingMessageId: () => props.editingMessageId ?? null,
  hasTail: () => props.hasTail ?? false,
  hasOlderMessages: () => props.hasOlderMessages,
  following: () => !props.showReturnToLatest,
}, {
  onActiveMessageChange: messageId => emit('activeMessageChange', messageId),
  onContentResize: metrics => emit('contentResize', metrics),
  onReaderScrollIntent: () => emit('readerScrollIntent'),
  onScroll: (metrics, options) => emit('scroll', metrics, options),
})
defineExpose<BuddyChatTranscriptViewportHandle>(handle)
</script>

<template>
  <div ref="root" class="buddy-chat-transcript-viewport relative h-full min-h-0">
    <div class="buddy-chat-transcript-viewport__scrollport h-full overflow-x-hidden overflow-y-scroll" @scroll="handleScroll">
      <div
        ref="content"
        class="buddy-chat-transcript-viewport__content relative min-h-full"
        :style="{ height: `${totalHeight}px` }"
        :data-transcript-row-count="rows.length"
      >
        <BuddyChatVirtualRow
          v-for="row in virtualRows"
          :key="String(row.key)"
          :ref="measureRow"
          :row-key="String(row.key)"
          :data-index="row.index"
          :style="{ transform: `translateY(${row.start + (row.items.length || row.spacer ? 0 : tailOffset)}px)`, height: row.spacer ? `${row.size}px` : undefined }"
        >
          <template v-for="item in row.items" :key="item.key">
            <slot :item="item" />
          </template>
          <slot v-if="!row.items.length && !row.spacer" name="tail" />
        </BuddyChatVirtualRow>
      </div>
    </div>
    <Transition name="buddy-chat-return-to-latest">
      <div
        v-if="showReturnToLatest"
        class="buddy-chat-transcript-viewport__return absolute z-3 bottom-[0.85rem] left-[50%]"
      >
        <BuddyChatReturnToLatest
          :label="returnToLatestLabel"
          @activate="emit('returnToLatest')"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-transcript-viewport {
  container-type: inline-size;
  contain: strict;
}

.buddy-chat-transcript-viewport__scrollport {
  overflow-anchor: none;
  overscroll-behavior: contain;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: var(--buddy-border-strong);

    &:hover {
      background: var(--buddy-text-disabled);
    }
  }

  &:focus-visible {
    outline: 0;
  }
}

.buddy-chat-transcript-viewport__content {
  width: 100%;

  :deep(.markdown-renderer) {
    content-visibility: visible;
    contain-intrinsic-size: none;
  }
}

.buddy-chat-transcript-viewport__return {
  transform: translateX(-50%);
}

.buddy-chat-return-to-latest-enter-active {
  transition:
    opacity 160ms ease-out,
    transform 160ms var(--buddy-motion-state-easing);
}

.buddy-chat-return-to-latest-leave-active {
  pointer-events: none;
  transition:
    opacity 160ms ease-in,
    transform 160ms ease-in;
}

.buddy-chat-return-to-latest-enter-from,
.buddy-chat-return-to-latest-leave-to {
  opacity: 0;
  transform: translate(-50%, 0.35rem) scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-return-to-latest-enter-active,
  .buddy-chat-return-to-latest-leave-active {
    transition: none;
  }

  .buddy-chat-return-to-latest-enter-from,
  .buddy-chat-return-to-latest-leave-to {
    transform: translateX(-50%);
  }
}
</style>
