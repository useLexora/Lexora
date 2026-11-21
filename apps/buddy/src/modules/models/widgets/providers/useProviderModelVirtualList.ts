import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { Range, Virtualizer } from '@tanstack/vue-virtual'
import { defaultRangeExtractor, measureElement, useVirtualizer } from '@tanstack/vue-virtual'
import { computed, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'

const CHAT_ROW_ESTIMATE = 136
const OTHER_ROW_ESTIMATE = 76
const OVERSCAN = 8

export interface ProviderModelVirtualRow {
  model: LocalRuntimeModelOption
  key: string
  index: number
  offset: number | null
}

export function providerModelRowKey(providerId: string, modelId: string): string {
  return `${providerId.length}:${providerId}${modelId}`
}

/** Distance from the scrollport's content origin to `anchor`, including content already scrolled away. */
export function readScrollMargin(scroll: HTMLElement, anchor: HTMLElement): number {
  return anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
}

export function scrollOffsetForAnchor(scroll: HTMLElement, anchorOffset: number): number {
  const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
  return Math.min(Math.max(0, anchorOffset), max)
}

function scrollContent(scroll: HTMLElement, anchor: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = anchor
  while (node && node.parentElement !== scroll)
    node = node.parentElement
  return node
}

function measuredRowSize(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLElement, HTMLElement>,
): number {
  const measured = measureElement(element, entry, instance)
  if (measured > 0)
    return measured
  const index = instance.indexFromElement(element)
  if (index < 0 || index >= instance.options.count)
    return OTHER_ROW_ESTIMATE
  const key = instance.options.getItemKey(index)
  return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index)
}

export function useProviderModelVirtualList(options: {
  enabled: () => boolean
  scrollElement: () => HTMLElement | null
  providerId: () => string
  models: () => readonly LocalRuntimeModelOption[]
  anchor: () => HTMLElement | null
}) {
  const scrollMargin = shallowRef(0)
  const focusedKey = shallowRef<string | null>(null)
  const indexes = computed(() => new Map(options.models().map((model, index) => [
    providerModelRowKey(options.providerId(), model.modelId),
    index,
  ])))
  const virtualizer = useVirtualizer(computed(() => {
    const models = options.models()
    const providerId = options.providerId()
    const scrollElement = options.enabled() ? options.scrollElement() : null
    const focused = focusedKey.value
    return {
      count: scrollElement ? models.length : 0,
      estimateSize: (index: number) => models[index]?.type === 'chat' ? CHAT_ROW_ESTIMATE : OTHER_ROW_ESTIMATE,
      getItemKey: (index: number) => {
        const model = models[index]
        return model ? providerModelRowKey(providerId, model.modelId) : `${providerId.length}:${providerId}${index}`
      },
      getScrollElement: () => scrollElement,
      measureElement: measuredRowSize,
      overscan: OVERSCAN,
      rangeExtractor: (range: Range) => {
        const next = defaultRangeExtractor(range)
        const index = focused === null ? undefined : indexes.value.get(focused)
        if (index === undefined || next.includes(index))
          return next
        return [...next, index].sort((left, right) => left - right)
      },
      scrollMargin: scrollMargin.value,
    }
  }))
  const virtualRows = computed<ProviderModelVirtualRow[]>(() => {
    const models = options.models()
    const margin = scrollMargin.value
    return virtualizer.value.getVirtualItems().flatMap((item) => {
      const model = models[item.index]
      return model
        ? [{ model, key: String(item.key), index: item.index, offset: item.start - margin }]
        : []
    })
  })
  const totalHeight = computed(() => virtualizer.value.getTotalSize())

  let observer: ResizeObserver | null = null
  function syncScrollMargin() {
    const scroll = options.scrollElement()
    const anchor = options.anchor()
    if (!options.enabled() || !scroll || !anchor)
      return
    const next = readScrollMargin(scroll, anchor)
    if (Number.isFinite(next) && Math.abs(next - scrollMargin.value) > 0.5)
      scrollMargin.value = next
  }

  function bindObserver() {
    observer?.disconnect()
    observer = null
    const scroll = options.scrollElement()
    const anchor = options.anchor()
    if (!options.enabled() || !scroll || !anchor || typeof ResizeObserver === 'undefined') {
      syncScrollMargin()
      return
    }
    observer = new ResizeObserver(() => syncScrollMargin())
    const content = scrollContent(scroll, anchor)
    if (content)
      observer.observe(content, { box: 'border-box' })
    observer.observe(anchor, { box: 'border-box' })
    syncScrollMargin()
  }

  watch(
    () => [options.enabled(), options.scrollElement(), options.anchor(), options.providerId(), options.models().length] as const,
    () => bindObserver(),
    { flush: 'post', immediate: true },
  )

  function rememberFocusedRow(event: FocusEvent) {
    const target = event.target instanceof Element ? event.target : null
    const row = target?.closest<HTMLElement>('[data-provider-model-key]')
    focusedKey.value = row?.dataset.providerModelKey ?? null
  }

  function releaseFocusedRow(event: FocusEvent) {
    const next = event.relatedTarget
    const anchor = options.anchor()
    if (!(next instanceof Node) || !anchor?.contains(next))
      focusedKey.value = null
  }

  function measureRow(node: Element | null) {
    virtualizer.value.measureElement(node instanceof HTMLElement ? node : null)
  }

  /** After a filter change, pull the viewport back to the results block if the user had scrolled past it. */
  function revealResults(section: HTMLElement | null) {
    focusedKey.value = null
    void nextTick(() => {
      syncScrollMargin()
      const scroll = options.scrollElement()
      if (!scroll || !section)
        return
      const next = scrollOffsetForAnchor(scroll, readScrollMargin(scroll, section))
      if (scroll.scrollTop > next + 1)
        scroll.scrollTop = next
    })
  }

  function revealPageStart() {
    focusedKey.value = null
    const scroll = options.scrollElement()
    if (scroll && scroll.scrollTop !== 0)
      scroll.scrollTop = 0
    void nextTick(syncScrollMargin)
  }

  onBeforeUnmount(() => observer?.disconnect())

  return {
    measureRow,
    releaseFocusedRow,
    rememberFocusedRow,
    revealPageStart,
    revealResults,
    totalHeight,
    virtualRows,
  }
}
