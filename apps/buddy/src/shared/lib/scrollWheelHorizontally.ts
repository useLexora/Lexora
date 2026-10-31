export function scrollWheelHorizontally(event: WheelEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.shiftKey || event.deltaX !== 0 || event.deltaY === 0)
    return
  const port = event.currentTarget
  if (!(port instanceof HTMLElement))
    return
  let delta = event.deltaY
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const style = getComputedStyle(port)
    delta *= Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize)
  }
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    delta *= port.clientWidth
  }
  const before = port.scrollLeft
  port.scrollBy({ left: delta, behavior: 'instant' })
  if (port.scrollLeft !== before)
    event.preventDefault()
}
