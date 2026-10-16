import type {
  ComputedRef,
  CSSProperties,
  Ref,
} from 'vue'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  shallowRef,
  watch,
} from 'vue'
import { getChatStreamingProbe } from './utils/chat-streaming-probe'

interface StoredListScrollState {
  scrollTop: number
  stickToBottom: boolean
}

const MAX_STORED_LIST_SCROLL_STATE = 80

export interface DynamicChatVirtualItem<T> {
  item: T
  index: number
  key: string
  style: CSSProperties
}

export interface DynamicChatVirtualListOptions<T> {
  items: Readonly<Ref<readonly T[]>> | ComputedRef<readonly T[]>
  listKey: Readonly<Ref<string | null | undefined>> | ComputedRef<string | null | undefined>
  scrollContainerRef: Readonly<Ref<HTMLElement | null>>
  getItemKey: (item: T, index: number) => string
  estimateSize: number
  overscan?: number
  bottomThreshold?: number
}

export function useDynamicChatVirtualList<T>(options: DynamicChatVirtualListOptions<T>) {
  const overscan = options.overscan ?? 8
  const bottomThreshold = options.bottomThreshold ?? 72
  const scrollTop = shallowRef(0)
  const viewportHeight = shallowRef(0)
  const sizeVersion = shallowRef(0)
  const sizeByKey = new Map<string, number>()
  const elementByKey = new Map<string, HTMLElement>()
  const keyByElement = new Map<Element, string>()
  const scrollStateByListKey = new Map<string, StoredListScrollState>()
  let resizeObserver: ResizeObserver | null = null
  let containerResizeObserver: ResizeObserver | null = null
  let shouldStickToBottom = true
  let pendingScrollBottom = false
  let pendingStoredScrollRestoreKey: string | null = null

  const normalizedListKey = computed(() => options.listKey.value ?? '__default__')
  const itemKeys = computed(() => options.items.value.map(options.getItemKey))
  const keyIndexByKey = computed(() => {
    const indexByKey = new Map<string, number>()

    itemKeys.value.forEach((key, index) => {
      indexByKey.set(key, index)
    })

    return indexByKey
  })
  const offsets = computed<number[]>(() => {
    const keys = itemKeys.value
    const nextOffsets: number[] = [0]
    let offset = 0

    void sizeVersion.value

    for (let index = 0; index < keys.length; index += 1) {
      offset += sizeByKey.get(keys[index] ?? '') ?? options.estimateSize
      nextOffsets.push(offset)
    }

    return nextOffsets
  })
  const totalHeight = computed(() => offsets.value.at(-1) ?? 0)
  const range = computed(() => resolveDynamicVirtualRange({
    itemCount: options.items.value.length,
    offsets: offsets.value,
    overscan,
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
  }))
  const virtualItems = computed<DynamicChatVirtualItem<T>[]>(() => {
    const items = options.items.value
    const keys = itemKeys.value
    const nextItems: DynamicChatVirtualItem<T>[] = []

    for (let index = range.value.start; index < range.value.end; index += 1) {
      const item = items[index]
      const key = keys[index]

      if (item === undefined || key === undefined) {
        continue
      }

      nextItems.push({
        item,
        index,
        key,
        style: {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          transform: `translateY(${offsets.value[index] ?? 0}px)`,
          width: '100%',
        },
      })
    }

    return nextItems
  })
  const spacerStyle = computed<CSSProperties>(() => ({
    height: `${totalHeight.value}px`,
    minHeight: '100%',
    position: 'relative',
  }))

  watch(() => options.scrollContainerRef.value, (element) => {
    disconnectContainerResizeObserver()

    if (!element) {
      scrollTop.value = 0
      viewportHeight.value = 0
      return
    }

    updateScrollMetrics()

    if (typeof ResizeObserver !== 'undefined') {
      containerResizeObserver = new ResizeObserver(() => {
        updateScrollMetrics()
        scheduleScrollToBottomIfNeeded()
      })
      containerResizeObserver.observe(element)
    }

    void nextTick(() => restoreListScroll(normalizedListKey.value))
  }, {
    flush: 'post',
    immediate: true,
  })

  watch(normalizedListKey, (nextKey, previousKey) => {
    const element = options.scrollContainerRef.value

    if (element && previousKey) {
      saveListScrollState(previousKey, element.scrollTop, shouldStickToBottom || isNearBottom())
    }

    const storedScrollState = scrollStateByListKey.get(nextKey)
    shouldStickToBottom = storedScrollState?.stickToBottom ?? true
    pendingStoredScrollRestoreKey = storedScrollState ? nextKey : null

    void nextTick(() => {
      restoreListScroll(nextKey)

      if (pendingStoredScrollRestoreKey === nextKey) {
        pendingStoredScrollRestoreKey = null
      }
    })
  })

  watch(itemKeys, async (nextKeys, previousKeys = []) => {
    const hasKeyStructureChanged = !areStringArraysEqual(nextKeys, previousKeys)

    if (hasKeyStructureChanged) {
      pruneMeasurements(nextKeys)
    }

    const shouldRestoreStoredScroll = pendingStoredScrollRestoreKey === normalizedListKey.value
    const wasNearBottom = isNearBottom()
    const shouldScrollBottom = !shouldRestoreStoredScroll
      && hasKeyStructureChanged
      && (shouldStickToBottom || wasNearBottom || previousKeys.length === 0)

    await nextTick()
    updateScrollMetrics()

    if (shouldRestoreStoredScroll) {
      restoreListScroll(normalizedListKey.value)
      pendingStoredScrollRestoreKey = null
      return
    }

    if (shouldScrollBottom) {
      scrollToBottom()
    }
  }, {
    flush: 'post',
  })

  onBeforeUnmount(() => {
    disconnectContainerResizeObserver()
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  function handleScroll(): void {
    const probe = getChatStreamingProbe()
    const startedAt = probe ? performance.now() : 0
    updateScrollMetrics()
    shouldStickToBottom = isNearBottom()

    const key = normalizedListKey.value
    const element = options.scrollContainerRef.value
    if (element) {
      saveListScrollState(key, element.scrollTop, shouldStickToBottom)
    }

    probe?.recordVirtualList?.({
      kind: 'handle-scroll',
      listKey: key,
      durationMs: performance.now() - startedAt,
      scrollTop: element?.scrollTop ?? 0,
      scrollHeight: element?.scrollHeight ?? 0,
      clientHeight: element?.clientHeight ?? 0,
    })
  }

  function setItemElement(key: string, element: Element | null): void {
    const previousElement = elementByKey.get(key)

    if (previousElement && previousElement === element) {
      return
    }

    if (previousElement && previousElement !== element) {
      resizeObserver?.unobserve(previousElement)
      keyByElement.delete(previousElement)
      elementByKey.delete(key)
    }

    if (!(element instanceof HTMLElement)) {
      return
    }

    ensureResizeObserver()
    elementByKey.set(key, element)
    keyByElement.set(element, key)
    resizeObserver?.observe(element)
    measureItem(key, element)
  }

  function scrollToBottom(): void {
    const element = options.scrollContainerRef.value
    if (!element) {
      return
    }

    const probe = getChatStreamingProbe()
    const startedAt = probe ? performance.now() : 0
    element.scrollTop = element.scrollHeight
    updateScrollMetrics()
    shouldStickToBottom = true
    saveListScrollState(normalizedListKey.value, element.scrollTop, true)

    probe?.recordVirtualList?.({
      kind: 'scroll-to-bottom',
      listKey: normalizedListKey.value,
      durationMs: performance.now() - startedAt,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    })
  }

  function updateScrollMetrics(): void {
    const element = options.scrollContainerRef.value
    if (!element) {
      scrollTop.value = 0
      viewportHeight.value = 0
      return
    }

    scrollTop.value = element.scrollTop
    viewportHeight.value = element.clientHeight
  }

  function restoreListScroll(key: string): void {
    const element = options.scrollContainerRef.value
    if (!element) {
      return
    }

    const storedScrollState = scrollStateByListKey.get(key)

    if (storedScrollState) {
      if (storedScrollState.stickToBottom) {
        scrollToBottom()
        return
      }

      element.scrollTop = storedScrollState.scrollTop
      shouldStickToBottom = false
      updateScrollMetrics()
      return
    }

    scrollToBottom()
  }

  function ensureResizeObserver(): void {
    if (resizeObserver || typeof ResizeObserver === 'undefined') {
      return
    }

    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = keyByElement.get(entry.target)
        if (!key || !(entry.target instanceof HTMLElement)) {
          continue
        }

        measureItem(key, entry.target)
      }
    })
  }

  function measureItem(key: string, element: HTMLElement): void {
    const probe = getChatStreamingProbe()
    const startedAt = probe ? performance.now() : 0
    const nextSize = Math.ceil(element.getBoundingClientRect().height)

    probe?.recordVirtualList?.({
      kind: 'measure-item',
      listKey: normalizedListKey.value,
      itemKey: key,
      durationMs: performance.now() - startedAt,
      size: nextSize,
    })

    if (nextSize <= 0) {
      return
    }

    const previousSize = sizeByKey.get(key) ?? options.estimateSize
    if (previousSize === nextSize && sizeByKey.has(key)) {
      return
    }

    const index = keyIndexByKey.value.get(key) ?? -1
    const itemTop = index >= 0 ? offsets.value[index] ?? 0 : 0
    const itemBottom = itemTop + previousSize
    const wasNearBottom = isNearBottom()
    const shouldAnchorViewport = !wasNearBottom && itemBottom <= scrollTop.value
    const delta = nextSize - previousSize

    sizeByKey.set(key, nextSize)
    sizeVersion.value += 1

    if (shouldAnchorViewport && delta !== 0) {
      adjustScrollTop(delta)
      return
    }

    if (wasNearBottom || shouldStickToBottom) {
      scheduleScrollToBottomIfNeeded()
    }
  }

  function adjustScrollTop(delta: number): void {
    const element = options.scrollContainerRef.value
    if (!element) {
      return
    }

    element.scrollTop += delta
    updateScrollMetrics()
    saveListScrollState(normalizedListKey.value, element.scrollTop, shouldStickToBottom)
  }

  function scheduleScrollToBottomIfNeeded(): void {
    if (pendingScrollBottom) {
      return
    }

    pendingScrollBottom = true
    const scheduleFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 16)

    scheduleFrame(() => {
      pendingScrollBottom = false

      if (shouldStickToBottom || isNearBottom()) {
        scrollToBottom()
      }
    })
  }

  function isNearBottom(): boolean {
    return isNearScrollBottom(options.scrollContainerRef.value, bottomThreshold)
  }

  function pruneMeasurements(keys: readonly string[]): void {
    const keySet = new Set(keys)

    for (const key of sizeByKey.keys()) {
      if (!keySet.has(key)) {
        sizeByKey.delete(key)
      }
    }

    for (const [key, element] of elementByKey.entries()) {
      if (keySet.has(key)) {
        continue
      }

      resizeObserver?.unobserve(element)
      keyByElement.delete(element)
      elementByKey.delete(key)
    }

    sizeVersion.value += 1
  }

  function disconnectContainerResizeObserver(): void {
    containerResizeObserver?.disconnect()
    containerResizeObserver = null
  }

  function saveListScrollState(key: string, nextScrollTop: number, stickToBottom: boolean): void {
    if (scrollStateByListKey.has(key)) {
      scrollStateByListKey.delete(key)
    }

    scrollStateByListKey.set(key, {
      scrollTop: nextScrollTop,
      stickToBottom,
    })

    while (scrollStateByListKey.size > MAX_STORED_LIST_SCROLL_STATE) {
      const oldestKey = scrollStateByListKey.keys().next().value
      if (!oldestKey) {
        break
      }

      scrollStateByListKey.delete(oldestKey)
    }
  }

  return {
    handleScroll,
    scrollToBottom,
    setItemElement,
    spacerStyle,
    totalHeight,
    virtualItems,
  }
}

export function resolveDynamicVirtualRange(input: {
  itemCount: number
  offsets: readonly number[]
  overscan: number
  scrollTop: number
  viewportHeight: number
}) {
  if (input.itemCount === 0) {
    return {
      start: 0,
      end: 0,
    }
  }

  const viewportEnd = input.scrollTop + input.viewportHeight
  const start = Math.min(
    input.itemCount - 1,
    Math.max(0, findOffsetIndex(input.offsets, input.scrollTop) - input.overscan),
  )
  const end = Math.min(
    input.itemCount,
    Math.max(start + 1, findOffsetIndex(input.offsets, viewportEnd) + input.overscan + 1),
  )

  return {
    start,
    end: Math.max(end, start + 1),
  }
}

function areStringArraysEqual(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) {
    return false
  }

  return first.every((value, index) => value === second[index])
}

export function isNearScrollBottom(element: HTMLElement | null, threshold: number): boolean {
  if (!element) {
    return true
  }

  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}

function findOffsetIndex(offsets: readonly number[], target: number): number {
  let low = 0
  let high = Math.max(0, offsets.length - 1)

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const nextOffset = offsets[middle + 1] ?? Number.POSITIVE_INFINITY

    if (nextOffset <= target) {
      low = middle + 1
      continue
    }

    high = middle
  }

  return low
}
