import type { ComponentPublicInstance, Ref } from 'vue'
import type { ReaderEntry } from './readerBridge'
import type { ReaderAnchor } from './readerProjection'
import type { ReaderUpdate } from './readerProtocol'
import { defaultRangeExtractor, elementScroll, useVirtualizer } from '@tanstack/vue-virtual'
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, onMounted, onUnmounted, shallowRef, watch } from 'vue'

export function useReaderViewport(viewport: Ref<HTMLElement | null>, entries: Ref<ReaderEntry[]>, topic: Ref<string>, anchor: Ref<ReaderAnchor | null>, hasLaterMessages: Ref<boolean>, paging: { state: Ref<ReaderUpdate['history']>, load: (retry: boolean) => void }) {
  const followsEnd = shallowRef(true)
  const hasMoreBelow = shallowRef(false)
  const nearHistoryStart = shallowRef(true)
  const readingHistory = shallowRef(false)
  const anchorStatus = shallowRef<'idle' | 'locating' | 'located' | 'missing'>('idle')
  const locatedMessageId = shallowRef<string | null>(null)
  const showLatest = computed(() => !hasLaterMessages.value && (readingHistory.value || (!followsEnd.value && hasMoreBelow.value)))
  const selected = shallowRef<number[]>([])
  const locatingIndex = shallowRef<number | null>(null)
  let anchorFrame = 0
  let navigation = 0
  let lastAnchorRequest: string | null = null
  let frame = 0
  let touching = false
  let lastTop = 0
  let requestedBoundary: number | string | null = null
  let fillFrame = 0
  let programmaticTop: number | null = null
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(computed(() => {
    const items = entries.value
    return {
      count: items.length,
      getScrollElement: () => viewport.value,
      getItemKey: (index: number) => items[index]!.id,
      estimateSize: (index: number) => {
        const entry = items[index]!
        if (entry.messages[0]?.role === 'tool')
          return 70
        return 100 + entry.messages.reduce((height, message) => height + Math.ceil(message.text.length / 28) * 26, 0)
      },
      overscan: 3,
      paddingStart: 18,
      paddingEnd: 24,
      anchorTo: 'end' as const,
      followOnAppend: followsEnd.value,
      scrollEndThreshold: followsEnd.value ? 24 : 0,
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => [...new Set([...defaultRangeExtractor(range), ...selected.value, ...(locatingIndex.value === null ? [] : [locatingIndex.value])])].sort((a, b) => a - b),
      onChange: () => {
        report()
        follow()
      },
      scrollToFn: (offset, options, instance) => {
        programmaticTop = offset + (options.adjustments ?? 0)
        elementScroll(offset, options, instance)
      },
    }
  }))
  virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => !followsEnd.value && item.end <= (instance.scrollOffset ?? 0)
  const rows = computed(() => virtualizer.value.getVirtualItems().flatMap((row) => {
    const entry = entries.value[row.index]
    return entry ? [{ ...row, entry }] : []
  }))
  const height = computed(() => virtualizer.value.getTotalSize())

  function report() {
    const element = viewport.value
    const size = virtualizer.value.getTotalSize()
    hasMoreBelow.value = Boolean(element && size - element.clientHeight - element.scrollTop > 24)
    nearHistoryStart.value = Boolean(element && element.scrollTop < element.clientHeight * 0.8)
  }
  const boundary = computed(() => paging.state.value?.page ?? entries.value[0]?.id ?? '')
  function requestOlder(reason: 'fill' | 'scroll' | 'retry') {
    const state = paging.state.value
    if (!topic.value || !state?.available || state.loading || (reason === 'retry' ? !state.error : state.error || requestedBoundary === boundary.value))
      return
    requestedBoundary = boundary.value
    paging.load(reason === 'retry')
  }
  function fitsViewport() {
    const el = viewport.value
    return !!el && el.clientHeight > 0 && Math.max(el.scrollHeight, virtualizer.value.getTotalSize()) <= el.clientHeight + 1
  }
  function scheduleFill() {
    cancelAnimationFrame(fillFrame)
    fillFrame = requestAnimationFrame(() => {
      report()
      if (anchorStatus.value !== 'locating' && anchorStatus.value !== 'missing' && fitsViewport())
        requestOlder('fill')
    })
  }
  useResizeObserver(viewport, scheduleFill)
  watch([viewport, height, topic, boundary, () => paging.state.value?.available, () => paging.state.value?.loading, () => paging.state.value?.error, anchorStatus], scheduleFill, { flush: 'post' })
  function follow() {
    cancelAnimationFrame(frame)
    if (!followsEnd.value || touching || window.getSelection()?.toString())
      return
    frame = requestAnimationFrame(() => {
      const element = viewport.value
      if (followsEnd.value && !touching && element && Math.abs(Math.max(0, virtualizer.value.getTotalSize() - element.clientHeight) - element.scrollTop) > 1)
        virtualizer.value.scrollToEnd()
    })
  }
  function cancelAnchor() {
    navigation++
    cancelAnimationFrame(anchorFrame)
    locatingIndex.value = null
  }
  function resumeLatest() {
    requestedBoundary = null
    scheduleFill()
    cancelAnchor()
    anchorStatus.value = 'idle'
    locatedMessageId.value = null
    readingHistory.value = false
    followsEnd.value = true
    follow()
  }
  function latest() {
    if (!hasLaterMessages.value)
      resumeLatest()
  }
  async function locate(request: ReaderAnchor) {
    cancelAnchor()
    const current = navigation
    followsEnd.value = false
    readingHistory.value = true
    cancelAnimationFrame(frame)
    locatedMessageId.value = null
    anchorStatus.value = 'locating'
    const index = entries.value.findIndex(entry => entry.messages.some(message => message.id === request.messageId))
    if (request.topic !== topic.value || index < 0) {
      anchorStatus.value = 'missing'
      return
    }
    locatingIndex.value = index
    await nextTick()
    if (current !== navigation)
      return
    virtualizer.value.scrollToIndex(index, { align: 'start' })
    let attempts = 0
    const align = () => {
      if (current !== navigation || request.topic !== topic.value)
        return
      const element = viewport.value
      const message = [...element?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []].find(element => element.dataset.messageId === request.messageId)
      if (element && message) {
        const offset = message.getBoundingClientRect().top - element.getBoundingClientRect().top
        const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + offset))
        if (Math.abs(element.scrollTop - target) <= 2) {
          anchorStatus.value = 'located'
          locatedMessageId.value = request.messageId
          locatingIndex.value = null
          return
        }
        virtualizer.value.scrollToOffset(target)
      }
      if (++attempts < 12) {
        anchorFrame = requestAnimationFrame(align)
      }
      else {
        anchorStatus.value = 'missing'
        locatingIndex.value = null
      }
    }
    anchorFrame = requestAnimationFrame(align)
  }
  function scroll() {
    const element = viewport.value
    if (!element)
      return
    report()
    const atEnd = element.scrollHeight - element.clientHeight - element.scrollTop < 24
    const automatic = programmaticTop !== null && Math.abs(element.scrollTop - programmaticTop) < 2
    if (!automatic && (touching || element.scrollTop < lastTop - 2))
      followsEnd.value = atEnd && !readingHistory.value && !hasLaterMessages.value
    else if (atEnd && !readingHistory.value && !hasLaterMessages.value)
      followsEnd.value = true
    if (!automatic && element.scrollTop < lastTop - 1 && nearHistoryStart.value && anchorStatus.value !== 'locating')
      requestOlder('scroll')
    programmaticTop = null
    lastTop = element.scrollTop
  }
  function touch(active: boolean) {
    touching = active
    if (active)
      cancelAnchor()
    if (!active)
      follow()
  }
  function measure(element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement)
      virtualizer.value.measureElement(element)
  }
  function retainSelection() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed) {
      selected.value = []
      return
    }
    const range = selection.getRangeAt(0)
    const indexes = [...viewport.value?.querySelectorAll<HTMLElement>('[data-index]') ?? []]
      .filter(element => range.intersectsNode(element))
      .map(element => Number(element.dataset.index))
    selected.value = indexes
  }
  watch(topic, () => {
    requestedBoundary = null
    lastTop = 0
    cancelAnchor()
    anchorStatus.value = 'idle'
    locatedMessageId.value = null
    readingHistory.value = Boolean(anchor.value) || hasLaterMessages.value
    followsEnd.value = !readingHistory.value
    selected.value = []
    virtualizer.value.measure()
    follow()
  })
  watch(() => anchor.value ? JSON.stringify([anchor.value.topic, anchor.value.requestId]) : null, (request) => {
    if (anchor.value && request !== lastAnchorRequest) {
      lastAnchorRequest = request
      void locate(anchor.value)
    }
    else if (!anchor.value) {
      cancelAnchor()
      anchorStatus.value = 'idle'
      locatedMessageId.value = null
    }
  })
  watch(hasLaterMessages, (current, previous) => {
    if (current) {
      readingHistory.value = true
      followsEnd.value = false
      cancelAnimationFrame(frame)
    }
    else if (previous && !anchor.value) {
      resumeLatest()
    }
  })
  watch(entries, follow, { flush: 'post' })
  onMounted(() => document.addEventListener('selectionchange', retainSelection))
  onUnmounted(() => {
    document.removeEventListener('selectionchange', retainSelection)
    cancelAnimationFrame(frame)
    cancelAnimationFrame(fillFrame)
    cancelAnchor()
  })
  const visibleRows = computed(() => {
    const range = virtualizer.value.range
    return range ? rows.value.filter(row => row.index >= range.startIndex && row.index <= range.endIndex) : []
  })
  return { rows, visibleRows, height, nearHistoryStart, retryOlder: () => requestOlder('retry'), followsEnd, showLatest, anchorStatus, locatedMessageId, latest, scroll, touch, measure }
}
