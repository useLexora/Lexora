<script setup lang="ts">
import type {
  BuddyChatTranscriptViewportHandle,
  ChatMessageScrollMetrics,
} from './chatMessageViewport'
import { NScrollbar } from 'naive-ui'
import { useTemplateRef } from 'vue'
import BuddyChatReturnToLatest from './BuddyChatReturnToLatest.vue'
import { useChatTranscriptViewport } from './useChatTranscriptViewport'

const props = defineProps<{
  hasOlderMessages: boolean
  returnToLatestLabel: string
  showReturnToLatest: boolean
}>()

const emit = defineEmits<{
  activeMessageChange: [messageId: string | null]
  contentResize: [metrics: ChatMessageScrollMetrics]
  returnToLatest: []
  scroll: [metrics: ChatMessageScrollMetrics, options?: { userInitiated?: boolean }]
}>()

const root = useTemplateRef<HTMLElement>('root')
const content = useTemplateRef<HTMLElement>('content')
const { handle, handleScroll } = useChatTranscriptViewport(root, content, {
  onActiveMessageChange: messageId => emit('activeMessageChange', messageId),
  onContentResize: metrics => emit('contentResize', metrics),
  onScroll: (metrics, options) => emit('scroll', metrics, options),
})
defineExpose<BuddyChatTranscriptViewportHandle>(handle)
</script>

<template>
  <div ref="root" class="buddy-chat-transcript-viewport relative h-full min-h-0">
    <NScrollbar
      class="buddy-chat-transcript-viewport__scrollbar"
      container-class="buddy-chat-transcript-viewport__scrollport"
      content-style="min-height: 100%"
      trigger="none"
      @scroll="handleScroll"
    >
      <div
        ref="content"
        class="buddy-chat-transcript-viewport__content min-h-full"
        :class="{ 'has-older-messages': props.hasOlderMessages }"
      >
        <slot />
      </div>
    </NScrollbar>
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
}

:deep(.buddy-chat-transcript-viewport__scrollbar) {
  height: 100%;

  .n-scrollbar-rail--vertical .n-scrollbar-rail__scrollbar {
    transition:
      height 160ms ease-out,
      background-color 160ms ease-out;

    &:active {
      transition: none;
    }
  }
}

:deep(.buddy-chat-transcript-viewport__scrollport) {
  overflow-anchor: none;
  overscroll-behavior: contain;

  &:focus-visible {
    outline: 0;
  }
}

.buddy-chat-transcript-viewport__content {
  width: 100cqw;
  padding-block: 1.5rem 1rem;

  &.has-older-messages {
    padding-top: 2rem;
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
  :deep(.buddy-chat-transcript-viewport__scrollbar .n-scrollbar-rail--vertical .n-scrollbar-rail__scrollbar) {
    transition: none;
  }

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
