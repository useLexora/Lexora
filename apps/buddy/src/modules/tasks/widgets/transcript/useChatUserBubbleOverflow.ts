import type { Ref } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { onBeforeUnmount, onMounted, onUpdated, shallowRef } from 'vue'
import { useChatTranscriptValue } from './chatTranscriptPresentation'

const pending = new Map<HTMLElement, (overflowing: boolean) => void>()
let frame: number | null = null

function measurePending() {
  frame = null
  const entries = [...pending].filter(([element]) => element.isConnected)
  pending.clear()
  const expanded = entries.filter(([element]) => !element.classList.contains('is-collapsed'))
  for (const [element] of expanded)
    element.classList.add('is-measuring')
  const results = entries.map(([element, update]) => {
    const height = element.clientHeight
    return { update, overflowing: height > 0 ? element.scrollHeight > height + 1 : null }
  })
  for (const [element] of expanded)
    element.classList.remove('is-measuring')
  for (const { update, overflowing } of results) {
    if (overflowing !== null)
      update(overflowing)
  }
}

export function useChatUserBubbleOverflow(body: Readonly<Ref<HTMLElement | null>>) {
  const expanded = useChatTranscriptValue('user-bubble:expanded', false)
  const overflowing = shallowRef(false)
  let disposed = false

  function update(value: boolean) {
    overflowing.value = value
    if (!value)
      expanded.value = false
  }

  function schedule() {
    if (disposed || !body.value)
      return
    pending.set(body.value, update)
    if (frame === null)
      frame = requestAnimationFrame(measurePending)
  }

  useResizeObserver(body, schedule)
  useEventListener(() => document.fonts, 'loadingdone', schedule)
  onMounted(() => {
    schedule()
    void document.fonts?.ready.then(schedule)
  })
  onUpdated(schedule)
  onBeforeUnmount(() => {
    disposed = true
    if (body.value)
      pending.delete(body.value)
    if (!pending.size && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  })

  return { expanded, overflowing }
}
