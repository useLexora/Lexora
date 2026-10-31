import { createSharedComposable, useEventListener } from '@vueuse/core'

interface WheelGesture {
  delta: number
  lastEvent: number
  lastZoom: number
}

// Both libraries teleport their previews outside the component's DOM tree.
// Share one listener across all mounted previews, and release it with the last scope.
export const usePreviewWheelZoom = createSharedComposable(() => {
  const gestures = new WeakMap<Element, WheelGesture>()

  useEventListener('wheel', (event: WheelEvent) => {
    if (!(event.target instanceof Element) || !Number.isFinite(event.deltaY)
      || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
      return
    }

    const overlay = event.target.closest('.n-image-preview-container, .mermaid-modal-panel')
    if (!overlay)
      return

    const direction = event.deltaY < 0 ? 'in' : 'out'
    const button = findZoomButton(overlay, direction)
    if (!button)
      return

    event.preventDefault()
    event.stopPropagation()

    const now = Date.now()
    let gesture = gestures.get(overlay)
    if (!gesture) {
      gesture = { delta: 0, lastEvent: now, lastZoom: Number.NEGATIVE_INFINITY }
      gestures.set(overlay, gesture)
    }
    if (now - gesture.lastEvent > 200 || Math.sign(gesture.delta) !== Math.sign(event.deltaY))
      gesture.delta = 0

    // Normalize mouse-wheel lines/pages and accumulate small trackpad movements.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? overlay.clientHeight || window.innerHeight : 1
    gesture.delta += event.deltaY * unit
    gesture.lastEvent = now
    if (Math.abs(gesture.delta) < 40 || now - gesture.lastZoom < 80)
      return

    gesture.delta = 0
    gesture.lastZoom = now
    button.click()
  }, { capture: true, passive: false })
})

function findZoomButton(overlay: Element, direction: 'in' | 'out'): HTMLButtonElement | undefined {
  if (overlay.matches('.n-image-preview-container'))
    return overlay.querySelector<HTMLButtonElement>(`[data-preview-zoom="${direction}"]`) ?? undefined

  // markstream-vue 2.0.19's modal toolbar has zoom in, zoom out, reset, close
  // in that order, without action attributes. Keep this adapter covered by a
  // real-component test when upgrading the dependency; never match translated text.
  const buttons = overlay.querySelectorAll<HTMLButtonElement>(':scope > div:first-child > button.mermaid-action-btn')
  return buttons[direction === 'in' ? 0 : 1]
}
