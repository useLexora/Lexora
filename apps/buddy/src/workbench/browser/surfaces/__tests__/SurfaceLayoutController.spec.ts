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

it('retains a browser viewport while hidden without exposing input or focus', async () => {
  const layout = new SurfaceLayoutController()
  const anchor = document.createElement('div')
  const surface = document.createElement('div')
  document.body.append(anchor, surface)
  const options = { anchor, visible: false, interactive: true, retainSizeWhenHidden: true, layer: 'content' as const }
  const lease = layout.attach(surface, options)
  layout.start()
  try {
    expect(surface.style.width).toBe(`${window.innerWidth}px`)
    expect(surface.style.height).toBe(`${window.innerHeight}px`)
    anchor.getBoundingClientRect = () => new DOMRect(40, 50, 640, 480)
    lease.update({ ...options, visible: true })
    await Promise.resolve()
    expect(surface.style.visibility).toBe('visible')
    lease.update(options)
    await Promise.resolve()
    expect(surface.style.width).toBe('640px')
    expect(surface.style.height).toBe('480px')
    expect(surface.style.visibility).toBe('visible')
    expect(surface.style.opacity).toBe('0')
    expect(surface.style.left).toBe('0px')
    expect(surface.style.top).toBe('0px')
    expect(surface.style.pointerEvents).toBe('none')
    expect(surface.inert).toBe(true)
    expect(surface.tabIndex).toBe(-1)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    lease.update({ ...options, visible: true })
    await Promise.resolve()
    expect(surface.style.opacity).toBe('1')
    expect(surface.style.pointerEvents).toBe('auto')
    expect(surface.inert).toBe(false)
    expect(surface.tabIndex).toBe(0)
    expect(surface.hasAttribute('aria-hidden')).toBe(false)
  }
  finally {
    layout.dispose()
  }
})

function transition(type: 'transitionrun' | 'transitionend' | 'transitioncancel', target: Element, propertyName = 'width') {
  target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { propertyName }))
}

function movableAnchor(layout = new SurfaceLayoutController()) {
  const scope = document.createElement('section')
  const sidebar = document.createElement('div')
  const anchor = document.createElement('div')
  const surface = document.createElement('iframe')
  sidebar.dataset.workbenchLayoutTransition = 'width'
  scope.append(sidebar, anchor)
  document.body.append(scope, surface)
  const position = { left: 190, measured: 0 }
  anchor.getBoundingClientRect = () => {
    position.measured++
    return new DOMRect(position.left, 0, 700, 400)
  }
  layout.attach(surface, { anchor, visible: true, interactive: true, layer: 'content' })
  layout.start()
  return { layout, scope, sidebar, surface, position }
}

it('follows declared sibling layout transitions without measuring unrelated animations or scopes', async () => {
  const { layout, sidebar, surface, position } = movableAnchor()
  const other = movableAnchor(layout)
  const label = document.createElement('span')
  sidebar.append(label)
  try {
    await vi.advanceTimersByTimeAsync(20)
    const measured = position.measured
    const otherMeasured = other.position.measured
    transition('transitionrun', label, 'transform')
    transition('transitionrun', sidebar, 'opacity')
    transition('transitionend', label, 'transform')
    await vi.advanceTimersByTimeAsync(32)
    expect(position.measured).toBe(measured)
    expect(vi.getTimerCount()).toBe(0)

    transition('transitionrun', sidebar)
    position.left = 100
    await vi.advanceTimersByTimeAsync(16)
    expect(surface.style.left).toBe('100px')
    position.left = 40
    await vi.advanceTimersByTimeAsync(16)
    expect(surface.style.left).toBe('40px')
    position.left = 0
    transition('transitionend', sidebar)
    expect(surface.style.left).toBe('0px')
    expect(other.position.measured).toBe(otherMeasured)
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    layout.dispose()
  }
})

it('settles interrupted transitions and releases frame work when detached or disposed', async () => {
  const { layout, scope, sidebar, surface, position } = movableAnchor()
  try {
    await vi.advanceTimersByTimeAsync(20)
    transition('transitionrun', sidebar)
    transition('transitionrun', sidebar)
    transition('transitioncancel', sidebar)
    position.left = 60
    await vi.advanceTimersByTimeAsync(16)
    expect(surface.style.left).toBe('60px')
    position.left = 40
    transition('transitioncancel', sidebar)
    expect(surface.style.left).toBe('40px')
    expect(vi.getTimerCount()).toBe(0)

    transition('transitionrun', sidebar)
    sidebar.remove()
    await vi.advanceTimersByTimeAsync(16)
    expect(vi.getTimerCount()).toBe(0)
    scope.append(sidebar)
    transition('transitionrun', sidebar)
    layout.dispose()
    const measured = position.measured
    transition('transitionrun', sidebar)
    await vi.advanceTimersByTimeAsync(32)
    expect(position.measured).toBe(measured)
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    layout.dispose()
  }
})
