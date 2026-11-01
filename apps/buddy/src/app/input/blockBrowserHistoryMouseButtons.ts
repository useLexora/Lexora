const HISTORY_MOUSE_BUTTONS = new Set([3, 4])

/** Cancels the Chromium default that treats side buttons as history navigation. */
export function blockBrowserHistoryMouseButtons(target: EventTarget = window): () => void {
  const onMouseUp = (event: Event) => {
    if (!(event instanceof MouseEvent) || !HISTORY_MOUSE_BUTTONS.has(event.button))
      return
    event.preventDefault()
  }
  target.addEventListener('mouseup', onMouseUp, true)
  return () => target.removeEventListener('mouseup', onMouseUp, true)
}
