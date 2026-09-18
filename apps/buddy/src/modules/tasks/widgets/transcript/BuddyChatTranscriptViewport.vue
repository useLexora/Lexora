<script setup lang="ts">
import type {
  BuddyChatTranscriptViewportHandle,
  ChatMessageScrollAnchor,
  ChatMessageScrollMetrics,
} from './chatMessageViewport'
import { NScrollbar } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import BuddyChatReturnToLatest from './BuddyChatReturnToLatest.vue'
import { createChatFrameTask, resolvePrependedChatScrollTop } from './chatMessageViewport'
import { createChatTranscriptDomIndex } from './chatTranscriptDomIndex'

const props = defineProps<{
  hasOlderMessages: boolean
  returnToLatestLabel: string
  showReturnToLatest: boolean
}>()

const emit = defineEmits<{
  activeMessageChange: [messageId: string | null]
  contentResize: [metrics: ChatMessageScrollMetrics]
  returnToLatest: []
  scroll: [metrics: ChatMessageScrollMetrics]
}>()

const content = useTemplateRef<HTMLElement>('content')
const viewport = computed(() => content.value?.closest<HTMLElement>('.buddy-chat-transcript-viewport__scrollport') ?? null)
let resizeObserver: ResizeObserver | null = null
let viewportFrameTask: ReturnType<typeof createChatFrameTask> | null = null
let domIndex: ReturnType<typeof createChatTranscriptDomIndex> | null = null

function readScrollMetrics(): ChatMessageScrollMetrics | null {
  return viewport.value ? toScrollMetrics(viewport.value) : null
}

function captureScrollAnchor(): ChatMessageScrollAnchor | null {
  const scrollport = viewport.value
  const metrics = readScrollMetrics()
  if (!scrollport || !metrics)
    return null
  const viewportTop = scrollport.getBoundingClientRect().top
  const message = domIndex?.firstRowBelow(viewportTop)
  if (!message?.dataset.chatRowKey)
    return null
  return {
    messageId: message.dataset.messageId ?? '',
    rowKey: message.dataset.chatRowKey,
    messageOffsetTop: message.getBoundingClientRect().top - viewportTop,
    metrics,
  }
}

function restoreScrollAnchor(anchor: ChatMessageScrollAnchor): ChatMessageScrollMetrics | null {
  const scrollport = viewport.value
  if (!scrollport)
    return null
  const anchorMessage = anchor.rowKey
    ? domIndex?.findRow(anchor.rowKey)
    : findMessage(anchor.messageId)
  if (anchorMessage) {
    const currentOffset = anchorMessage.getBoundingClientRect().top
      - scrollport.getBoundingClientRect().top
    scrollport.scrollTop += currentOffset - anchor.messageOffsetTop
  }
  else {
    scrollport.scrollTop = resolvePrependedChatScrollTop(
      anchor.metrics,
      toScrollMetrics(scrollport),
    )
  }
  return toScrollMetrics(scrollport)
}

function scrollToMessage(
  messageId: string,
  behavior: ScrollBehavior = 'auto',
): ChatMessageScrollMetrics | null {
  const scrollport = viewport.value
  const message = findMessage(messageId)
  if (!scrollport || !message)
    return null
  const metrics = toScrollMetrics(scrollport)
  const nextTop = Math.min(
    Math.max(
      0,
      scrollport.scrollTop
      + message.getBoundingClientRect().top
      - scrollport.getBoundingClientRect().top,
    ),
    Math.max(0, scrollport.scrollHeight - scrollport.clientHeight),
  )
  const animate = behavior === 'smooth'
    && Math.abs(nextTop - scrollport.scrollTop) <= scrollport.clientHeight * 2
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  scrollport.scrollTo({
    behavior: animate ? 'smooth' : 'auto',
    top: nextTop,
  })
  return {
    ...metrics,
    scrollTop: nextTop,
  }
}

function scrollToTail(): ChatMessageScrollMetrics | null {
  const scrollport = viewport.value
  if (!scrollport)
    return null
  scrollport.scrollTop = scrollport.scrollHeight
  return toScrollMetrics(scrollport)
}

function scrollBy(deltaY: number) {
  if (viewport.value)
    viewport.value.scrollTop += deltaY
}

function findMessage(messageId: string): HTMLElement | null {
  return domIndex?.findMessage(messageId) ?? null
}

function readActiveMessageId(): string | null {
  const scrollport = viewport.value
  if (!scrollport)
    return null
  const bounds = scrollport.getBoundingClientRect()
  const message = domIndex?.firstMessageBelow(bounds.top)
  return message && message.getBoundingClientRect().top < bounds.bottom
    ? message.dataset.messageId ?? null
    : null
}

function scheduleActiveMessageChange() {
  viewportFrameTask?.schedule()
}

function handleScroll() {
  const metrics = readScrollMetrics()
  if (metrics)
    emit('scroll', metrics)
  scheduleActiveMessageChange()
}

onMounted(() => {
  if (content.value)
    domIndex = createChatTranscriptDomIndex(content.value)
  if (viewport.value) {
    viewport.value.tabIndex = 0
    viewport.value.dataset.chatScrollViewport = ''
  }
  viewportFrameTask = createChatFrameTask(
    () => {
      emit('activeMessageChange', readActiveMessageId())
    },
    requestAnimationFrame,
    cancelAnimationFrame,
  )
  if (!content.value || typeof ResizeObserver === 'undefined')
    return
  resizeObserver = new ResizeObserver(() => {
    const metrics = readScrollMetrics()
    if (metrics)
      emit('contentResize', metrics)
    scheduleActiveMessageChange()
  })
  resizeObserver.observe(content.value)
  scheduleActiveMessageChange()
})

onBeforeUnmount(() => {
  domIndex?.dispose()
  resizeObserver?.disconnect()
  viewportFrameTask?.cancel()
})

defineExpose<BuddyChatTranscriptViewportHandle>({
  captureScrollAnchor,
  readScrollMetrics,
  restoreScrollAnchor,
  scrollBy,
  scrollToMessage,
  scrollToTail,
})

function toScrollMetrics(element: HTMLElement): ChatMessageScrollMetrics {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}
</script>

<template>
  <div class="buddy-chat-transcript-viewport">
    <NScrollbar
      class="buddy-chat-transcript-viewport__scrollbar"
      container-class="buddy-chat-transcript-viewport__scrollport"
      content-style="min-height: 100%"
      trigger="none"
      @scroll="handleScroll"
    >
      <div
        ref="content"
        class="buddy-chat-transcript-viewport__content"
        :class="{ 'has-older-messages': props.hasOlderMessages }"
      >
        <slot />
      </div>
    </NScrollbar>
    <Transition name="buddy-chat-return-to-latest">
      <div
        v-if="showReturnToLatest"
        class="buddy-chat-transcript-viewport__return"
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
  position: relative;
  height: 100%;
  min-height: 0;
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
  min-height: 100%;
  padding-block: 1.5rem 1rem;

  &.has-older-messages {
    padding-top: 2rem;
  }
}

.buddy-chat-transcript-viewport__return {
  position: absolute;
  z-index: 3;
  bottom: 0.85rem;
  left: 50%;
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
