import type { Ref } from 'vue'
import type { BuddyChatTranscriptViewportHandle, ChatMessageScrollAnchor, ChatMessageScrollMetrics } from './chatMessageViewport'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { createChatFrameTask, resolvePrependedChatScrollTop } from './chatMessageViewport'
import { createChatTranscriptDomIndex } from './chatTranscriptDomIndex'

interface TranscriptViewportEvents {
  onActiveMessageChange: (messageId: string | null) => void
  onContentResize: (metrics: ChatMessageScrollMetrics) => void
  onScroll: (metrics: ChatMessageScrollMetrics, options: { userInitiated: boolean }) => void
}

export function useChatTranscriptViewport(
  root: Readonly<Ref<HTMLElement | null>>,
  content: Readonly<Ref<HTMLElement | null>>,
  events: TranscriptViewportEvents,
) {
  const viewport = computed(() => content.value?.closest<HTMLElement>('.buddy-chat-transcript-viewport__scrollport') ?? null)
  let resizeObserver: ResizeObserver | null = null
  let viewportFrameTask: ReturnType<typeof createChatFrameTask> | null = null
  let domIndex: ReturnType<typeof createChatTranscriptDomIndex> | null = null

  let isUserInteracting = false
  let userInteractionTimer: number | null = null
  let isPointerDragging = false

  function markUserInteraction() {
    isUserInteracting = true
    if (userInteractionTimer !== null)
      window.clearTimeout(userInteractionTimer)
    userInteractionTimer = window.setTimeout(() => {
      isUserInteracting = false
      userInteractionTimer = null
    }, 160)
  }

  function handleWheel() {
    markUserInteraction()
  }

  function handleTouchMove() {
    markUserInteraction()
  }

  function handleKeyDown(event: KeyboardEvent) {
    const scrollKeys = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']
    if (scrollKeys.includes(event.key))
      markUserInteraction()
  }

  function handlePointerDown() {
    isPointerDragging = true
    markUserInteraction()
  }

  function handlePointerUp() {
    isPointerDragging = false
    markUserInteraction()
  }

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
    if (metrics) {
      const userInitiated = isUserInteracting || isPointerDragging
      events.onScroll(metrics, { userInitiated })
    }
    scheduleActiveMessageChange()
  }

  onMounted(() => {
    if (content.value)
      domIndex = createChatTranscriptDomIndex(content.value)
    const scrollport = viewport.value
    const rootEl = root.value
    if (scrollport) {
      scrollport.tabIndex = 0
      scrollport.dataset.chatScrollViewport = ''
      scrollport.addEventListener('wheel', handleWheel, { passive: true })
      scrollport.addEventListener('touchmove', handleTouchMove, { passive: true })
      scrollport.addEventListener('keydown', handleKeyDown)
    }
    if (rootEl) {
      rootEl.addEventListener('pointerdown', handlePointerDown)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
    }
    viewportFrameTask = createChatFrameTask(
      () => {
        events.onActiveMessageChange(readActiveMessageId())
      },
      requestAnimationFrame,
      cancelAnimationFrame,
    )
    if (typeof ResizeObserver === 'undefined')
      return
    resizeObserver = new ResizeObserver(() => {
      const metrics = readScrollMetrics()
      if (metrics)
        events.onContentResize(metrics)
      scheduleActiveMessageChange()
    })
    if (content.value)
      resizeObserver.observe(content.value)
    if (scrollport)
      resizeObserver.observe(scrollport)
    scheduleActiveMessageChange()
  })

  onBeforeUnmount(() => {
    domIndex?.dispose()
    resizeObserver?.disconnect()
    viewportFrameTask?.cancel()
    const scrollport = viewport.value
    const rootEl = root.value
    if (scrollport) {
      scrollport.removeEventListener('wheel', handleWheel)
      scrollport.removeEventListener('touchmove', handleTouchMove)
      scrollport.removeEventListener('keydown', handleKeyDown)
    }
    if (rootEl) {
      rootEl.removeEventListener('pointerdown', handlePointerDown)
    }
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    if (userInteractionTimer !== null) {
      window.clearTimeout(userInteractionTimer)
      userInteractionTimer = null
    }
  })

  const handle: BuddyChatTranscriptViewportHandle = {
    captureScrollAnchor,
    readScrollMetrics,
    restoreScrollAnchor,
    scrollBy,
    scrollToMessage,
    scrollToTail,
  }
  return { handle, handleScroll }
}

function toScrollMetrics(element: HTMLElement): ChatMessageScrollMetrics {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}
