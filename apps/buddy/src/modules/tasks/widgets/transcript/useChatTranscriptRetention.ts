import type { Range } from '@tanstack/vue-virtual'
import type { Ref } from 'vue'
import { defaultRangeExtractor } from '@tanstack/vue-virtual'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, shallowRef } from 'vue'

export function useChatTranscriptRetention(
  root: Readonly<Ref<HTMLElement | null>>,
  rowKeys: Readonly<Ref<readonly string[]>>,
  editingKey: Readonly<Ref<string | null>>,
) {
  const selectionKeys = shallowRef<string[]>([])
  const selectAll = shallowRef(false)
  const dragKey = shallowRef<string | null>(null)
  const focusKey = shallowRef<string | null>(null)
  const indexByKey = computed(() => new Map(rowKeys.value.map((key, index) => [key, index])))

  function rowKey(node: Node | null): string | null {
    const element = node instanceof Element ? node : node?.parentElement
    const row = element?.closest<HTMLElement>('[data-virtual-row-key]')
    return row && root.value?.contains(row) ? row.dataset.virtualRowKey ?? null : null
  }

  useEventListener(document, 'selectionchange', () => {
    const selection = document.getSelection()
    const endpoints = selection && !selection.isCollapsed
      ? [rowKey(selection.anchorNode), rowKey(selection.focusNode)]
      : []
    const keys = endpoints.filter((key): key is string => key !== null)
    let entireContainer = false
    let extendSelection: (() => void) | undefined
    if (selection && !selection.isCollapsed && selection.rangeCount && root.value) {
      const range = selection.getRangeAt(0)
      const mounted = [...root.value.querySelectorAll<HTMLElement>('[data-virtual-row-key]')]
      const container = mounted[0]?.parentElement ?? root.value
      entireContainer = range.comparePoint(container, 0) === 0 && range.comparePoint(container, container.childNodes.length) === 0
      if (entireContainer && !selectAll.value && range.startContainer === container && range.endContainer === container) {
        extendSelection = () => {
          if (selectAll.value && selection.rangeCount && selection.getRangeAt(0) === range && root.value?.contains(container))
            range.setEnd(container, container.childNodes.length)
        }
      }
      if (endpoints.includes(null)) {
        for (const row of mounted) {
          if (range.intersectsNode(row) && row.dataset.virtualRowKey)
            keys.push(row.dataset.virtualRowKey)
        }
      }
    }
    selectAll.value = entireContainer
    if (keys.join('\0') !== selectionKeys.value.join('\0'))
      selectionKeys.value = keys
    if (extendSelection)
      void nextTick(extendSelection)
  })
  useEventListener(root, 'pointerdown', (event: PointerEvent) => {
    if (event.button === 0)
      dragKey.value = rowKey(event.target as Node)
  })
  useEventListener(window, ['pointerup', 'pointercancel', 'blur'], () => dragKey.value = null)
  useEventListener(root, 'focusin', (event: FocusEvent) => focusKey.value = rowKey(event.target as Node))
  useEventListener(root, 'focusout', (event: FocusEvent) => focusKey.value = rowKey(event.relatedTarget as Node | null))

  return computed(() => {
    const index = indexByKey.value
    if (selectAll.value)
      return () => rowKeys.value.map((_, index) => index)
    const selected = selectionKeys.value.flatMap(key => index.has(key) ? [index.get(key)!] : [])
    const dragging = dragKey.value ? index.get(dragKey.value) : undefined
    const retained = [focusKey.value, editingKey.value].flatMap(key => key && index.has(key) ? [index.get(key)!] : [])
    return (range: Range): number[] => {
      const result = new Set([...defaultRangeExtractor(range), ...retained])
      if (selected.length || dragging !== undefined) {
        const ends = [...selected]
        if (dragging !== undefined)
          ends.push(dragging, range.startIndex, range.endIndex)
        else if (selected.length === 1)
          ends.push(range.startIndex, range.endIndex)
        const start = Math.min(...ends)
        const end = Math.max(...ends)
        for (let item = start; item <= end; item++)
          result.add(item)
      }
      return [...result].sort((left, right) => left - right)
    }
  })
}
