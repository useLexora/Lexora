// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SurfaceLayoutController } from '../SurfaceLayoutController'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('clips to its container while retaining the surface identity and uncut layout size', async () => {
  const layout = new SurfaceLayoutController()
  const parent = document.createElement('div')
  const anchor = document.createElement('div')
  const surface = document.createElement('div')
  parent.append(anchor)
  document.body.append(parent, surface)
  parent.style.overflowX = 'hidden'
  parent.style.overflowY = 'hidden'
  Object.defineProperties(parent, { clientWidth: { value: 200 }, clientHeight: { value: 100 }, offsetWidth: { value: 200 }, offsetHeight: { value: 100 } })
  parent.getBoundingClientRect = () => new DOMRect(100, 50, 200, 100)
  anchor.getBoundingClientRect = () => new DOMRect(80, 60, 240, 100)
  const lease = layout.attach(surface, { anchor, visible: true, interactive: true, layer: 'content' })
  layout.start()
  try {
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('visible')
    expect(surface.style.width).toBe('240px')
    expect(surface.style.clipPath).toBe('inset(0px 20px 10px 20px)')
    expect(surface.style.pointerEvents).toBe('auto')
    const originalParent = surface.parentElement
    anchor.getBoundingClientRect = () => new DOMRect(120, 70, 100, 60)
    layout.invalidate()
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.parentElement).toBe(originalParent)
    expect(surface.style.left).toBe('120px')
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 0px)')
    lease.update({ anchor, visible: false, interactive: true, layer: 'content' })
    expect(surface.style.visibility).toBe('hidden')
    expect(surface.tabIndex).toBe(-1)
    expect(surface.inert).toBe(true)
  }
  finally {
    layout.dispose()
  }
})

it('does not expose inactive anchors and ignores a released lease after another owner attaches', async () => {
  const layout = new SurfaceLayoutController()
  const anchor = document.createElement('div')
  const surface = document.createElement('div')
  document.body.append(anchor, surface)
  anchor.getBoundingClientRect = () => new DOMRect(20, 30, 80, 60)
  const options = { anchor, visible: true, interactive: true, layer: 'content' as const }
  const old = layout.attach(surface, options)
  layout.start()
  try {
    anchor.setAttribute('inert', '')
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('hidden')
    anchor.removeAttribute('inert')
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('visible')
    anchor.setAttribute('hidden', '')
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('hidden')
    anchor.removeAttribute('hidden')
    old.dispose()
    const current = layout.attach(surface, { ...options, interactive: false, layer: 'decoration' })
    old.update({ ...options, visible: false })
    old.dispose()
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('visible')
    expect(surface.style.pointerEvents).toBe('none')
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    anchor.remove()
    layout.invalidate()
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.visibility).toBe('hidden')
    current.dispose()
  }
  finally {
    layout.dispose()
  }
})

it('keeps a control above its popup and publishes hidden geometry when its anchor disappears', async () => {
  const layout = new SurfaceLayoutController()
  const popup = document.createElement('div')
  const anchor = document.createElement('div')
  const surface = document.createElement('iframe')
  popup.style.zIndex = '2000'
  popup.append(anchor)
  document.body.append(popup, surface)
  anchor.getBoundingClientRect = () => new DOMRect(40, 50, 240, 64)
  let geometry = { visible: false, width: 0, height: 0 }
  layout.attach(surface, { anchor, visible: true, interactive: true, layer: 'content', onLayout: next => geometry = next })
  layout.start()
  try {
    await vi.advanceTimersByTimeAsync(20)
    expect(surface.style.position).toBe('fixed')
    expect(surface.style.zIndex).toBe('2001')
    expect(geometry).toEqual({ visible: true, width: 240, height: 64 })
    popup.hidden = true
    await vi.advanceTimersByTimeAsync(20)
    expect(geometry).toEqual({ visible: false, width: 0, height: 0 })
    expect(surface.style.pointerEvents).toBe('none')
  }
  finally {
    layout.dispose()
  }
})

it('synchronizes moved surfaces before another input task instead of waiting for a paint', async () => {
  const layout = new SurfaceLayoutController()
  const anchor = document.createElement('div')
  const surface = document.createElement('iframe')
  document.body.append(anchor, surface)
  anchor.getBoundingClientRect = () => new DOMRect(700, 400, 320, 170)
  layout.attach(surface, { anchor, visible: true, interactive: true, layer: 'content' })
  layout.start()
  try {
    await Promise.resolve()
    expect(surface.style.left).toBe('700px')
    anchor.getBoundingClientRect = () => new DOMRect(180, 32, 1000, 90)
    anchor.style.height = '90px'
    await Promise.resolve()
    await Promise.resolve()
    expect(surface.style.left).toBe('180px')
    expect(surface.style.top).toBe('32px')
    expect(surface.style.width).toBe('1000px')
  }
  finally {
    layout.dispose()
  }
})
