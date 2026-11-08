import type { VirtualItem, Virtualizer } from '@tanstack/vue-virtual'
import type { ComponentPublicInstance, Ref } from 'vue'
import type { ChatTranscriptDisplayRow } from '../../model/transcript/chatMessageTime'
import type { BuddyChatTranscriptViewportHandle, ChatMessageScrollAnchor, ChatMessageScrollMetrics } from './chatMessageViewport'
import { elementScroll, measureElement, observeElementOffset, observeElementRect, useVirtualizer } from '@tanstack/vue-virtual'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import { createChatFrameTask } from './chatMessageViewport'
import { createChatTranscriptEstimator, readChatTranscriptEstimateLayout } from './chatTranscriptEstimates'
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
  const estimateHeight = createChatTranscriptEstimator()
  const estimateLayout = shallowRef({ width: 800, fontSize: 14, lineHeight: 24, codeFontSize: 12, rem: 16 })
  const replacementGapKey = 'turn-replacement-gap'
  const replacement = shallowRef<{ anchorKey: string, height: number, following: boolean } | null>(null)
  const rows = computed(() => {
    const result: { key: string, messageId: string | null, estimate: number, items: ChatTranscriptDisplayRow[], spacer?: boolean }[] = []
    let divider: ChatTranscriptDisplayRow | null = null
    for (const row of options.rows()) {
      if (row.kind === 'day-divider') {
        divider = row
        continue
      }
      result.push({ key: row.key, messageId: messageId(row), estimate: estimateHeight(row, estimateLayout.value) + (divider ? 52 : 0), items: divider ? [divider, row] : [row] })
      if (replacement.value?.following && replacement.value.anchorKey === row.key)
        result.push({ key: replacementGapKey, messageId: null, estimate: 0, items: [], spacer: true })
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
  const contentInsets = new Map<string, number>()
  watch(rowKeys, (keys) => {
    const current = new Set(keys)
    for (const cache of [widthEstimates, contentInsets]) {
      for (const key of cache.keys()) {
        if (!current.has(key))
          cache.delete(key)
      }
    }
  })
  const requestedAnchor = shallowRef<ChatMessageScrollAnchor | null>(null)
  const navigationRange = computed(() => {
    const extract = rangeExtractor.value
    const index = requestedAnchor.value ? anchorIndex(requestedAnchor.value) : undefined
    return index === undefined ? extract : (range: Parameters<typeof extract>[0]) => [...new Set([...extract(range), index])].sort((a, b) => a - b)
  })
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
    rangeExtractor: navigationRange.value,
    anchorTo: 'end' as const,
    followOnAppend: options.following(),
    scrollEndThreshold: options.following() ? 48 : 0,
    onChange: () => report.schedule(),
    scrollToFn: (offset, scrollOptions, instance) => {
      commitContentHeight(instance)
      programmaticTop = offset + (scrollOptions.adjustments ?? 0)
      elementScroll(offset, scrollOptions, instance)
    },
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      if (!rect.width || !rect.height)
        return
      const offset = instance.scrollOffset
      if (width && offset !== null && instance.scrollElement && Math.abs(instance.scrollElement.scrollTop - offset) > 1)
        instance.scrollToOffset(offset)
      const layout = readChatTranscriptEstimateLayout(instance.scrollElement!, rect.width)
      if (Object.entries(layout).some(([key, value]) => value !== estimateLayout.value[key as keyof typeof layout])) {
        if (width)
          layoutAnchor ??= captureScrollAnchor()
        estimateLayout.value = layout
        relayout.schedule()
      }
      else if (width && Math.abs(width - rect.width) > 0.5) {
        layoutAnchor ??= captureScrollAnchor()
        relayout.schedule()
      }
      width = rect.width
      callback(rect)
    }),
    observeElementOffset: (instance, callback) => observeElementOffset(instance, (offset, scrolling) => {
      if (instance.scrollElement?.clientHeight)
        callback(offset, scrolling)
      else if (!scrolling && instance.scrollOffset !== null)
        callback(instance.scrollOffset, false)
    }),
    measureElement: (element, entry, instance) => {
      const height = measureElement(element, entry, instance)
      if (height || element.offsetParent) {
        measureContentInset(element, instance)
        return height
      }
      return instance.itemSizeCache.get(element.dataset.virtualRowKey!) ?? widthEstimates.get(element.dataset.virtualRowKey!) ?? rows.value[Number(element.dataset.index)]?.estimate ?? 0
    },
  })))

  virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0
    if (requestedAnchor.value && item.index === anchorIndex(requestedAnchor.value))
      return false
    return instance.itemSizeCache.has(item.key) ? item.end <= offset : item.start < offset
  }

  function contentHeight(instance: Virtualizer<HTMLElement, HTMLElement>): number {
    return Math.max(instance.getTotalSize(), replacement.value?.height ?? 0, requestedAnchor.value?.rowSize !== undefined ? requestedAnchor.value.metrics.scrollHeight : 0, options.hasTail() ? instance.scrollRect?.height ?? 0 : 0)
  }

  function commitContentHeight(instance: Virtualizer<HTMLElement, HTMLElement>) {
    if (content.value)
      content.value.style.height = `${contentHeight(instance)}px`
  }

  const virtualRows = computed(() => virtualizer.value.getVirtualItems().map(item => ({ ...item, items: rows.value[item.index]!.items, spacer: rows.value[item.index]!.spacer })))
  const totalHeight = computed(() => contentHeight(virtualizer.value))
  const tailOffset = computed(() => Math.max(0, totalHeight.value - virtualizer.value.getTotalSize()))

  watch(rowKeys, (current, previous) => {
    if (!requestedAnchor.value)
      return
    const index = anchorIndex(requestedAnchor.value)
    if (index === undefined)
      requestedAnchor.value = null
    else if (current[index] !== previous[index])
      restoreScrollAnchor(requestedAnchor.value)
  }, { flush: 'post' })

  watch([virtualizer, replacement], () => {
    const index = indexes.value.keys.get(replacementGapKey)
    if (!replacement.value || index === undefined)
      return
    const instance = virtualizer.value
    if (instance.options.getItemKey(index) !== replacementGapKey)
      return
    const current = instance.itemSizeCache.get(replacementGapKey) ?? 0
    const height = Math.max(0, replacement.value.height - (instance.getTotalSize() - current))
    if (Math.abs(current - height) > 0.5)
      instance.resizeItem(index, height)
  }, { flush: 'post' })

  function prepareTurnReplacement(id: string, following: boolean) {
    finishTurnReplacement()
    const index = indexes.value.messages.get(id)
    const metrics = readScrollMetrics()
    if (index === undefined || !metrics)
      return
    const instance = virtualizer.value
    const row = rows.value[index]!
    const start = (instance.getOffsetForIndex(index, 'start')?.[0] ?? 0) + navigationOffset.value
    const prefixHeight = Math.min(metrics.scrollHeight, start + (instance.itemSizeCache.get(row.key) ?? row.estimate))
    const height = following
      ? prefixHeight + Math.min(metrics.scrollHeight - prefixHeight, metrics.clientHeight)
      : Math.min(metrics.scrollHeight, metrics.scrollTop + metrics.clientHeight)
    replacement.value = { anchorKey: row.key, height: Math.max(metrics.clientHeight, height), following }
  }

  function finishTurnReplacement() {
    const index = indexes.value.keys.get(replacementGapKey)
    const instance = virtualizer.value
    if (index !== undefined && instance.options.getItemKey(index) === replacementGapKey)
      instance.resizeItem(index, 0)
    replacement.value = null
  }

  function reportMetrics() {
    let metrics = readScrollMetrics()
    if (!metrics)
      return
    const anchor = requestedAnchor.value
    if (anchor) {
      const instance = virtualizer.value
      const index = anchorIndex(anchor)
      const items = instance.getVirtualItems()
      const item = items.find(item => item.index === index)
      if (item && isMeasured(item)) {
        const tail = items.filter(row => row.index >= item.index)
        const measuredTail = tail.length === rows.value.length - item.index && tail.every(isMeasured)
        const message = rows.value[item.index]!.items.find(row => row.kind === 'message')
        if (item.size < -anchor.messageOffsetTop && !message?.streaming) {
          restoreScrollAnchor({
            ...anchor,
            rowSize: item.size,
            messageOffsetTop: -Math.max(0, item.size - metrics.clientHeight),
            metrics: { ...metrics, scrollHeight: instance.getTotalSize() },
          })
          return
        }
        const rawTarget = item.start - anchor.messageOffsetTop
        const max = Math.max(0, instance.getTotalSize() - metrics.clientHeight)
        const target = Math.max(0, Math.min(rawTarget, max))
        const reached = Math.abs(metrics.scrollTop - rawTarget) < 1
          || (Math.abs(metrics.scrollTop - target) < 1 && measuredTail)
        if (item.size >= -anchor.messageOffsetTop && reached) {
          requestedAnchor.value = null
          commitContentHeight(instance)
          metrics = readScrollMetrics() ?? metrics
        }
      }
    }
    if (layoutAnchor || requestedAnchor.value)
      return
    events.onContentResize(metrics)
    if (options.following() && metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop > 1)
      virtualizer.value.scrollToEnd()
    const current = virtualizer.value.getVirtualItems().find(item => item.end > metrics.scrollTop && item.start < metrics.scrollTop + metrics.clientHeight && rows.value[item.index]?.messageId)
    events.onActiveMessageChange(current ? rows.value[current.index]?.messageId ?? null : null)
  }

  function measureContentInset(element: HTMLElement, instance: Virtualizer<HTMLElement, HTMLElement>) {
    const key = element.dataset.virtualRowKey!
    const body = element.querySelector<HTMLElement>('[data-message-id] .buddy-chat-message__body')
    if (!body || !element.offsetParent)
      return
    const inset = body.getBoundingClientRect().top - element.getBoundingClientRect().top
    const previous = contentInsets.get(key)
    contentInsets.set(key, inset)
    const index = Number(element.dataset.index)
    const anchor = requestedAnchor.value
    if (anchor && anchorIndex(anchor) === index && anchor.contentOffsetTop !== undefined && anchor.contentOffsetTop !== inset) {
      const offset = anchor.messageOffsetTop + anchor.contentOffsetTop - inset
      restoreScrollAnchor({ ...anchor, messageOffsetTop: offset, contentOffsetTop: inset })
    }
    else if (!anchor && previous !== undefined && previous !== inset && !options.following()) {
      const item = instance.measurementsCache[index]
      const offset = instance.scrollOffset ?? 0
      const metrics = readScrollMetrics()
      if (item && metrics && item.start <= offset && item.end > offset) {
        restoreScrollAnchor({ rowKey: key, rowSize: item.size, contentOffsetTop: inset, messageId: rows.value[index]?.messageId ?? '', messageOffsetTop: item.start - offset + previous - inset, metrics })
      }
    }
  }

  function isMeasured(item: VirtualItem): boolean {
    const element = virtualizer.value.elementsCache.get(item.key)
    return !!element?.isConnected && !!element.offsetParent && Math.abs(element.offsetHeight - item.size) < 1
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
    return element?.clientHeight ? { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop } : null
  }

  function captureScrollAnchor(): ChatMessageScrollAnchor | null {
    const metrics = readScrollMetrics()
    if (!metrics)
      return null
    if (requestedAnchor.value)
      return { ...requestedAnchor.value, metrics }
    const items = virtualizer.value.getVirtualItems()
    const item = items.find(item => item.end > metrics.scrollTop && !rows.value[item.index]?.spacer)
      ?? items.findLast(item => item.start <= metrics.scrollTop && !rows.value[item.index]?.spacer)
    const row = item && rows.value[item.index]
    return item && row ? { rowKey: row.key, rowSize: item.size, ...(contentInsets.has(row.key) ? { contentOffsetTop: contentInsets.get(row.key)! } : {}), messageId: row.messageId ?? '', messageOffsetTop: item.start - metrics.scrollTop, metrics } : null
  }

  function anchorIndex(anchor: ChatMessageScrollAnchor): number | undefined {
    return (anchor.rowKey ? indexes.value.keys.get(anchor.rowKey) : undefined) ?? indexes.value.messages.get(anchor.messageId)
  }

  function restoreScrollAnchor(anchor: ChatMessageScrollAnchor): ChatMessageScrollMetrics | null {
    const index = anchorIndex(anchor)
    if (index === undefined)
      return null
    const inset = contentInsets.get(rows.value[index]!.key)
    if (inset !== undefined && anchor.contentOffsetTop !== undefined)
      anchor = { ...anchor, messageOffsetTop: anchor.messageOffsetTop + anchor.contentOffsetTop - inset, contentOffsetTop: inset }
    generation++
    layoutAnchor = null
    requestedAnchor.value = anchor
    navigationOffset.value = anchor.messageOffsetTop
    const instance = virtualizer.value
    if (anchor.rowSize !== undefined && !instance.itemSizeCache.has(rows.value[index]!.key)) {
      for (const [key, height] of instance.itemSizeCache)
        widthEstimates.set(String(key), height)
      widthEstimates.set(rows.value[index]!.key, anchor.rowSize)
      instance.measure()
    }
    instance.setOptions({ ...instance.options, scrollPaddingStart: navigationOffset.value })
    instance.getVirtualItems()
    commitContentHeight(instance)
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
    requestedAnchor.value = { rowKey: rows.value[index]!.key, messageId: id, messageOffsetTop: 0, metrics }
    const instance = virtualizer.value
    instance.setOptions({ ...instance.options, scrollPaddingStart: 0 })
    commitContentHeight(instance)
    const target = instance.getOffsetForIndex(index, 'start')?.[0] ?? 0
    const animate = behavior === 'smooth' && Math.abs(target - metrics.scrollTop) <= metrics.clientHeight * 2
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    instance.scrollToIndex(index, { align: 'start', behavior: animate ? 'smooth' : 'auto' })
    return { ...metrics, scrollTop: target }
  }

  function scrollToTail(): ChatMessageScrollMetrics | null {
    generation++
    layoutAnchor = null
    requestedAnchor.value = null
    commitContentHeight(virtualizer.value)
    virtualizer.value.scrollToEnd()
    return readScrollMetrics()
  }

  function readerIntent() {
    generation++
    requestedAnchor.value = null
    layoutAnchor = null
    virtualizer.value.cancelScroll()
    interactingUntil = performance.now() + 160
    events.onReaderScrollIntent()
  }

  function handleScroll() {
    const metrics = readScrollMetrics()
    if (metrics && !layoutAnchor && !requestedAnchor.value) {
      const programmatic = programmaticTop !== null && Math.abs(programmaticTop - metrics.scrollTop) < 1
      programmaticTop = null
      events.onScroll(metrics, { userInitiated: !programmatic && (pointerDragging || performance.now() < interactingUntil) })
    }
    report.schedule()
  }

  useEventListener(viewport, ['wheel', 'touchmove'], readerIntent, { passive: true })
  useEventListener(viewport, 'keydown', (event: KeyboardEvent) => {
    if (event.defaultPrevented || (event.target instanceof Element
      && (event.target.closest('input, textarea, [contenteditable="true"]')
        || (event.key === ' ' && event.target.closest('button, a'))))) {
      return
    }
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key))
      readerIntent()
  })
  useEventListener(root, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, a, input, textarea, [contenteditable="true"]')))
      return
    pointerDragging = true
    readerIntent()
  })
  useEventListener(window, ['pointerup', 'pointercancel', 'blur'], () => pointerDragging = false)

  function measureRow(component: Element | ComponentPublicInstance | null) {
    const element = component instanceof Element ? component as HTMLElement : component?.$el ?? null
    if (element?.dataset.virtualRowKey !== replacementGapKey)
      virtualizer.value.measureElement(element)
  }

  const handle: BuddyChatTranscriptViewportHandle = {
    prepareTurnReplacement,
    finishTurnReplacement,
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
