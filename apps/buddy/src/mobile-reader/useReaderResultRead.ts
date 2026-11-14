import type { Ref } from 'vue'
import type { ReaderSend } from './readerProtocol'
import { useEventListener, useIntersectionObserver, useMutationObserver } from '@vueuse/core'
import { onScopeDispose, shallowRef, watch } from 'vue'

export function useReaderResultRead(root: Readonly<Ref<HTMLElement | null>>, resultRunId: Readonly<Ref<string | null>>, topic: Readonly<Ref<string>>, send: ReaderSend) {
  const targets = shallowRef<HTMLElement[]>([])
  let reported: string | null = null
  let frame: number | null = null
  let disposed = false
  function check() {
    frame = null
    if (disposed)
      return
    const id = resultRunId.value
    const viewport = root.value
    const elements = id && viewport ? [...viewport.querySelectorAll<HTMLElement>('[data-result-run-id]')].filter(element => element.dataset.resultRunId === id) : []
    if (elements.length !== targets.value.length || elements.some((element, index) => targets.value[index] !== element))
      targets.value = elements
    const visible = document.visibilityState === 'visible' && viewport && elements.some((element) => {
      const bounds = element.getBoundingClientRect()
      const clip = viewport.getBoundingClientRect()
      const left = Math.max(0, bounds.left, clip.left)
      const right = Math.min(innerWidth, bounds.right, clip.right)
      const top = Math.max(0, bounds.top, clip.top)
      const bottom = Math.min(innerHeight, bounds.bottom, clip.bottom)
      return right > left && bottom > top && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
    })
    if (!id || !visible) {
      reported = null
      return
    }
    const key = `${topic.value}:${id}`
    if (reported !== key) {
      reported = key
      send({ action: 'read-result', runId: id })
    }
  }
  function schedule() {
    if (frame === null && !disposed)
      frame = requestAnimationFrame(check)
  }
  watch([root, resultRunId, topic], schedule, { immediate: true, flush: 'post' })
  useMutationObserver(root, schedule, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-result-run-id'] })
  useIntersectionObserver(targets, schedule, { root })
  useEventListener(root, 'scroll', schedule, { passive: true })
  useEventListener(window, 'resize', schedule)
  useEventListener(document, 'visibilitychange', schedule)
  onScopeDispose(() => {
    disposed = true
    if (frame !== null)
      cancelAnimationFrame(frame)
  })
}
