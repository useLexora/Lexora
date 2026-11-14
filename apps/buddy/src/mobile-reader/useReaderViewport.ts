import type { ComponentPublicInstance, Ref } from 'vue'
import type { ReaderEntry } from './readerBridge'
import { defaultRangeExtractor, elementScroll, useVirtualizer } from '@tanstack/vue-virtual'
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'

export function useReaderViewport(viewport: Ref<HTMLElement | null>, entries: Ref<ReaderEntry[]>, topic: Ref<string>) {
  const followsEnd = shallowRef(true)
  const hasMoreBelow = shallowRef(false)
  const showLatest = computed(() => !followsEnd.value && hasMoreBelow.value)
  const selected = shallowRef<number[]>([])
  let frame = 0
  let touching = false
  let lastTop = 0
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
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => [...new Set([...defaultRangeExtractor(range), ...selected.value])].sort((a, b) => a - b),
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
    hasMoreBelow.value = Boolean(element && virtualizer.value.getTotalSize() - element.clientHeight - element.scrollTop > 24)
  }
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
  function latest() {
    followsEnd.value = true
    follow()
  }
  function scroll() {
    const element = viewport.value
    if (!element)
      return
    report()
    const atEnd = element.scrollHeight - element.clientHeight - element.scrollTop < 24
    const automatic = programmaticTop !== null && Math.abs(element.scrollTop - programmaticTop) < 2
    if (!automatic && (touching || element.scrollTop < lastTop - 2))
      followsEnd.value = atEnd
    else if (atEnd)
      followsEnd.value = true
    programmaticTop = null
    lastTop = element.scrollTop
  }
  function touch(active: boolean) {
    touching = active
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
    followsEnd.value = true
    selected.value = []
    virtualizer.value.measure()
    follow()
  })
  watch(entries, follow, { flush: 'post' })
  onMounted(() => document.addEventListener('selectionchange', retainSelection))
  onUnmounted(() => {
    document.removeEventListener('selectionchange', retainSelection)
    cancelAnimationFrame(frame)
  })
  return { rows, height, followsEnd, showLatest, latest, scroll, touch, measure }
}
