import type { ComponentPublicInstance, Ref } from 'vue'
import type { ChatTranscriptDisplayRow } from '../../model/transcript/chatMessageTime'
import type { BuddyChatTranscriptViewportHandle, ChatMessageScrollAnchor, ChatMessageScrollMetrics } from './chatMessageViewport'
import { elementScroll, measureElement, observeElementRect, useVirtualizer } from '@tanstack/vue-virtual'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import { createChatFrameTask } from './chatMessageViewport'
import { useChatTranscriptRetention } from './useChatTranscriptRetention'

interface TranscriptViewportEvents {
  onActiveMessageChange: (messageId: string | null) => void
  onContentResize: (metrics: ChatMessageScrollMetrics) => void
  onReaderScrollIntent: () => void
  onScroll: (metrics: ChatMessageScrollMetrics, options: { userInitiated: boolean }) => void
}

interface TranscriptViewportOptions {
  rows: () => readonly ChatTranscriptDisplayRow[]
  hasTail: () => boolean
  hasOlderMessages: () => boolean
  following: () => boolean
  editingMessageId: () => string | null
}

export function useChatTranscriptViewport(
  root: Readonly<Ref<HTMLElement | null>>,
  content: Readonly<Ref<HTMLElement | null>>,
  options: TranscriptViewportOptions,
  events: TranscriptViewportEvents,
) {
  const viewport = computed(() => content.value?.closest<HTMLElement>('.buddy-chat-transcript-viewport__scrollport') ?? null)
  watch(viewport, (element) => {
    if (element) {
      element.tabIndex = 0
      element.dataset.chatScrollViewport = ''
    }
  }, { flush: 'post' })
  const rows = computed(() => {
    const result: { key: string, messageId: string | null, estimate: number, items: ChatTranscriptDisplayRow[] }[] = []
    let divider: ChatTranscriptDisplayRow | null = null
    for (const row of options.rows()) {
      if (row.kind === 'day-divider') {
        divider = row
        continue
      }
      result.push({ key: row.key, messageId: messageId(row), estimate: estimateHeight(row) + (divider ? 52 : 0), items: divider ? [divider, row] : [row] })
      divider = null
    }
    if (options.hasTail())
      result.push({ key: 'pending-user-questions', messageId: null, estimate: 120, items: [] })
    return result
  })
  const rowKeys = computed(() => rows.value.map(row => row.key))
  const indexes = computed(() => ({
    keys: new Map(rows.value.map((row, index) => [row.key, index])),
    messages: new Map(rows.value.flatMap((row, index) => row.messageId ? [[row.messageId, index] as const] : [])),
  }))
  const editingKey = computed(() => rows.value.find(row => row.messageId === options.editingMessageId())?.key ?? null)
  const rangeExtractor = useChatTranscriptRetention(root, rowKeys, editingKey)
  const navigationOffset = shallowRef(0)
  const widthEstimates = new Map<string, number>()
  watch(rowKeys, (keys) => {
    const current = new Set(keys)
    for (const key of widthEstimates.keys()) {
      if (!current.has(key))
        widthEstimates.delete(key)
    }
  })
  let requestedAnchor: ChatMessageScrollAnchor | null = null
  let layoutAnchor: ChatMessageScrollAnchor | null = null
  let width = 0
  let generation = 0
  let disposed = false
  let interactingUntil = 0
  let pointerDragging = false
  let programmaticTop: number | null = null

  const report = createChatFrameTask(reportMetrics, requestAnimationFrame, cancelAnimationFrame)
  const relayout = createChatFrameTask(rebuildLayout, requestAnimationFrame, cancelAnimationFrame)

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(computed(() => ({
    count: rows.value.length,
    getScrollElement: () => viewport.value,
    getItemKey: (index: number) => rows.value[index]!.key,
    estimateSize: (index: number) => widthEstimates.get(rows.value[index]!.key) ?? rows.value[index]!.estimate,
    overscan: 3,
    paddingStart: options.hasOlderMessages() ? 32 : 24,
    paddingEnd: 16,
    scrollPaddingStart: navigationOffset.value,
    rangeExtractor: rangeExtractor.value,
    anchorTo: 'end' as const,
    followOnAppend: options.following(),
    scrollEndThreshold: options.following() ? 48 : 0,
    onChange: () => report.schedule(),
    scrollToFn: (offset, scrollOptions, instance) => {
      programmaticTop = offset + (scrollOptions.adjustments ?? 0)
      elementScroll(offset, scrollOptions, instance)
    },
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      if (!rect.width || !rect.height)
        return
      if (width && Math.abs(width - rect.width) > 0.5) {
        layoutAnchor ??= captureScrollAnchor()
        relayout.schedule()
      }
      width = rect.width
      callback(rect)
    }),
    measureElement: (element, entry, instance) => {
      const height = measureElement(element, entry, instance)
      if (height || element.offsetParent)
        return height
      return instance.itemSizeCache.get(element.dataset.virtualRowKey!) ?? widthEstimates.get(element.dataset.virtualRowKey!) ?? rows.value[Number(element.dataset.index)]?.estimate ?? 0
    },
  })))

  const virtualRows = computed(() => virtualizer.value.getVirtualItems().map(item => ({ ...item, items: rows.value[item.index]!.items })))
  const totalHeight = computed(() => Math.max(virtualizer.value.getTotalSize(), options.hasTail() ? virtualizer.value.scrollRect?.height ?? 0 : 0))
  const tailOffset = computed(() => Math.max(0, totalHeight.value - virtualizer.value.getTotalSize()))

  function reportMetrics() {
    const metrics = readScrollMetrics()
    if (!metrics)
      return
    if (requestedAnchor) {
      const index = anchorIndex(requestedAnchor)
      const target = index === undefined ? undefined : virtualizer.value.getOffsetForIndex(index, 'start')?.[0]
      if (target !== undefined && Math.abs(metrics.scrollTop - target) < 1)
        requestedAnchor = null
    }
    events.onContentResize(metrics)
    if (options.following() && metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop > 1)
      virtualizer.value.scrollToEnd()
    const current = virtualizer.value.getVirtualItems().find(item => item.end > metrics.scrollTop && item.start < metrics.scrollTop + metrics.clientHeight && rows.value[item.index]?.messageId)
    events.onActiveMessageChange(current ? rows.value[current.index]?.messageId ?? null : null)
  }

  function rebuildLayout() {
    const anchor = layoutAnchor
    layoutAnchor = null
    const revision = generation
    const following = options.following()
    for (const [key, height] of virtualizer.value.itemSizeCache)
      widthEstimates.set(String(key), height)
    virtualizer.value.measure()
    void nextTick(() => {
      if (disposed || revision !== generation)
        return
      if (following)
        scrollToTail()
      else if (anchor)
        restoreScrollAnchor(anchor)
    })
  }

  function readScrollMetrics(): ChatMessageScrollMetrics | null {
    const element = viewport.value
    return element ? { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop } : null
  }

  function captureScrollAnchor(): ChatMessageScrollAnchor | null {
    const metrics = readScrollMetrics()
    if (!metrics)
      return null
    if (requestedAnchor)
      return { ...requestedAnchor, metrics }
    const item = virtualizer.value.getVirtualItems().find(item => item.end > metrics.scrollTop)
    const row = item && rows.value[item.index]
    return item && row ? { rowKey: row.key, messageId: row.messageId ?? '', messageOffsetTop: item.start - metrics.scrollTop, metrics } : null
  }

  function anchorIndex(anchor: ChatMessageScrollAnchor): number | undefined {
    return (anchor.rowKey ? indexes.value.keys.get(anchor.rowKey) : undefined) ?? indexes.value.messages.get(anchor.messageId)
  }

  function restoreScrollAnchor(anchor: ChatMessageScrollAnchor): ChatMessageScrollMetrics | null {
    const index = anchorIndex(anchor)
    if (index === undefined)
      return null
    generation++
    layoutAnchor = null
    requestedAnchor = anchor
    navigationOffset.value = anchor.messageOffsetTop
    const instance = virtualizer.value
    instance.setOptions({ ...instance.options, scrollPaddingStart: navigationOffset.value })
    instance.getVirtualItems()
    instance.scrollToIndex(index, { align: 'start' })
    return readScrollMetrics()
  }

  function scrollToMessage(id: string, behavior: ScrollBehavior = 'auto'): ChatMessageScrollMetrics | null {
    const index = indexes.value.messages.get(id)
    const metrics = readScrollMetrics()
    if (index === undefined || !metrics)
      return null
    generation++
    layoutAnchor = null
    navigationOffset.value = 0
    requestedAnchor = { rowKey: rows.value[index]!.key, messageId: id, messageOffsetTop: 0, metrics }
    const instance = virtualizer.value
    instance.setOptions({ ...instance.options, scrollPaddingStart: 0 })
    const target = instance.getOffsetForIndex(index, 'start')?.[0] ?? 0
    const animate = behavior === 'smooth' && Math.abs(target - metrics.scrollTop) <= metrics.clientHeight * 2
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    instance.scrollToIndex(index, { align: 'start', behavior: animate ? 'smooth' : 'auto' })
    return { ...metrics, scrollTop: target }
  }

  function scrollToTail(): ChatMessageScrollMetrics | null {
    generation++
    layoutAnchor = null
    requestedAnchor = null
    virtualizer.value.scrollToEnd()
    return readScrollMetrics()
  }

  function readerIntent() {
    generation++
    requestedAnchor = null
    layoutAnchor = null
    virtualizer.value.cancelScroll()
    interactingUntil = performance.now() + 160
    events.onReaderScrollIntent()
  }

  function handleScroll() {
    const metrics = readScrollMetrics()
    if (metrics) {
      const programmatic = programmaticTop !== null && Math.abs(programmaticTop - metrics.scrollTop) < 1
      programmaticTop = null
      events.onScroll(metrics, { userInitiated: !programmatic && (pointerDragging || performance.now() < interactingUntil) })
    }
    report.schedule()
  }

  useEventListener(viewport, ['wheel', 'touchmove'], readerIntent, { passive: true })
  useEventListener(viewport, 'keydown', (event: KeyboardEvent) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key))
      readerIntent()
  })
  useEventListener(root, 'pointerdown', () => {
    pointerDragging = true
    readerIntent()
  })
  useEventListener(window, ['pointerup', 'pointercancel', 'blur'], () => pointerDragging = false)

  function measureRow(component: Element | ComponentPublicInstance | null) {
    virtualizer.value.measureElement(component instanceof Element ? component as HTMLElement : component?.$el ?? null)
  }

  const handle: BuddyChatTranscriptViewportHandle = {
    captureScrollAnchor,
    hasScrollAnchor: anchor => anchorIndex(anchor) !== undefined,
    readScrollMetrics,
    restoreScrollAnchor,
    scrollBy: (deltaY) => {
      readerIntent()
      virtualizer.value.scrollBy(deltaY)
      const metrics = readScrollMetrics()
      if (metrics)
        events.onScroll(metrics, { userInitiated: true })
    },
    scrollToMessage,
    scrollToTail,
  }
  onBeforeUnmount(() => {
    disposed = true
    report.cancel()
    relayout.cancel()
  })
  return { handle, handleScroll, measureRow, virtualRows, totalHeight, tailOffset }
}

function messageId(row: ChatTranscriptDisplayRow): string | null {
  return row.kind === 'message' ? row.message.id : row.kind === 'turn-result' ? row.turn.finalMessageId : null
}

function estimateHeight(row: ChatTranscriptDisplayRow): number {
  if (row.kind === 'day-divider')
    return 52
  if (row.kind === 'message')
    return row.message.role === 'user' ? 160 : 320
  return row.kind === 'activity' || row.kind === 'compaction' ? 64 : 160
}
