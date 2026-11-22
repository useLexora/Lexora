import type { Ref } from 'vue'
import { useEventListener } from '@vueuse/core'

export function useReaderLatestPull(viewport: Ref<HTMLElement | null>, owner: () => string | null, refresh: () => void) {
  let start: { owner: string, id: number, x: number, y: number, time: number } | null = null
  const eligible = () => viewport.value && viewport.value.scrollTop <= 1 && window.getSelection()?.isCollapsed !== false
  function cancel() {
    start = null
  }
  useEventListener(viewport, 'touchstart', (event) => {
    const key = owner()
    const finger = event.touches[0]
    start = key && eligible() && event.touches.length === 1 && finger
      && !(event.target instanceof Element && event.target.closest('button,a,input,textarea,[contenteditable=true]'))
      ? { owner: key, id: finger.identifier, x: finger.clientX, y: finger.clientY, time: event.timeStamp }
      : null
  }, { passive: true })
  useEventListener(viewport, 'touchmove', (event) => {
    const finger = event.touches[0]
    if (!start || !finger || event.touches.length !== 1 || finger.identifier !== start.id || !eligible()
      || Math.abs(finger.clientX - start.x) > 32 || finger.clientY < start.y - 6) {
      cancel()
    }
  }, { passive: true })
  useEventListener(viewport, 'touchend', (event) => {
    const origin = start
    cancel()
    const finger = event.changedTouches[0]
    if (origin && origin.owner === owner() && eligible() && !event.touches.length && finger?.identifier === origin.id
      && event.timeStamp - origin.time < 700 && Math.abs(finger.clientX - origin.x) <= 32 && finger.clientY - origin.y >= 72) {
      refresh()
    }
  }, { passive: true })
  useEventListener(viewport, ['touchcancel', 'contextmenu'], cancel, { passive: true })
}
