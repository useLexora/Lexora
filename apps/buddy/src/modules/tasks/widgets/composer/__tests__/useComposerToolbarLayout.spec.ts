// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowRef } from 'vue'
import { useComposerToolbarLayout } from '../useComposerToolbarLayout'

const compactSteps = ['space-short', 'effort', 'space', 'model-short', 'permission', 'model', 'tight']
const compactValues = Array.from({ length: 8 }, (_, level) => compactSteps.slice(0, level).join(' '))
const leadingWidths = [320, 280, 240, 200, 160, 120, 80, 60]
const actionWidths = [160, 150, 140, 130, 120, 110, 100, 90]
const cleanups: (() => void)[] = []
const observers: ControlledResizeObserver[] = []
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
let fonts: EventTarget
let originalFonts: PropertyDescriptor | undefined
let originalRootStyle: string | null

class ControlledResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()

  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  deliver(entries: ResizeObserverEntry[]) {
    const observed = entries.filter(entry => this.targets.has(entry.target))
    if (observed.length)
      this.callback(observed, this)
  }
}

beforeEach(() => {
  observers.length = 0
  frames.clear()
  frameId = 0
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  fonts = new EventTarget()
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  originalRootStyle = document.documentElement.getAttribute('style')
})

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  if (originalFonts)
    Object.defineProperty(document, 'fonts', originalFonts)
  else
    Reflect.deleteProperty(document, 'fonts')
  if (originalRootStyle === null)
    document.documentElement.removeAttribute('style')
  else
    document.documentElement.setAttribute('style', originalRootStyle)
  vi.unstubAllGlobals()
  frames.clear()
})

async function flushFrame() {
  await nextTick()
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(0))
  await nextTick()
}

async function mountToolbar(width = 420) {
  const host = document.createElement('div')
  const mountPoint = document.createElement('div')
  const toolbar = document.createElement('div')
  toolbar.className = 'test-composer-toolbar'
  const leading = document.createElement('div')
  leading.textContent = 'Workspace and model'
  const actions = document.createElement('div')
  actions.textContent = 'Send'
  toolbar.append(leading, actions)
  host.append(mountPoint, toolbar)
  document.body.append(host)
  const style = document.createElement('style')
  style.textContent = '.test-composer-toolbar { column-gap: 20px; }\n'
    + '.test-composer-toolbar[data-compact="space-short effort space model-short permission model tight"] { column-gap: 8px; }'
  document.head.append(style)

  const geometry = { width, leadingExtra: 0, actionsExtra: 0 }
  const reads = { toolbar: 0, leading: 0, actions: 0 }
  function level() {
    return compactValues.indexOf(toolbar.dataset.compact ?? '')
  }
  function size(target: Element) {
    if (!geometry.width || target === toolbar)
      return geometry.width
    return target === leading
      ? leadingWidths[level()] + geometry.leadingExtra
      : actionWidths[level()] + geometry.actionsExtra
  }
  for (const [name, element] of Object.entries({ toolbar, leading, actions })) {
    element.getBoundingClientRect = () => {
      reads[name as keyof typeof reads] += 1
      return new DOMRect(0, 0, size(element), 24)
    }
  }

  const app = createApp({
    setup() {
      useComposerToolbarLayout(shallowRef(toolbar), shallowRef(leading), shallowRef(actions))
      return () => null
    },
  })
  app.mount(mountPoint)
  let mounted = true
  function unmount() {
    if (mounted) {
      app.unmount()
      mounted = false
    }
  }
  cleanups.push(() => {
    unmount()
    host.remove()
    style.remove()
  })
  await nextTick()

  function notify(targets: Element[] = [toolbar, leading, actions]) {
    const entries = targets.map((target): ResizeObserverEntry => ({
      target,
      contentRect: new DOMRect(0, 0, size(target), 24),
      borderBoxSize: [{ inlineSize: size(target), blockSize: 24 }],
      contentBoxSize: [{ inlineSize: size(target), blockSize: 24 }],
      devicePixelContentBoxSize: [],
    }))
    observers.forEach(observer => observer.deliver(entries))
  }

  return {
    toolbar,
    leading,
    actions,
    geometry,
    reads,
    notify,
    unmount,
    async resize(nextWidth: number) {
      geometry.width = nextWidth
      notify([toolbar])
      await flushFrame()
    },
  }
}

describe('composer toolbar layout', () => {
  it.each([
    [500, 0],
    [450, 1],
    [400, 2],
    [350, 3],
    [300, 4],
    [250, 5],
    [200, 6],
    [158, 7],
    [100, 7],
  ])('selects the expected compact level at %i px (level %i)', async (width, level) => {
    const fixture = await mountToolbar(width)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[level])
    expect(fixture.leading.textContent).toBe('Workspace and model')
    expect(fixture.actions.textContent).toBe('Send')
    expect(Number.parseFloat(getComputedStyle(fixture.toolbar).columnGap)).toBe(level === 7 ? 8 : 20)
  })

  it('compacts immediately but needs exactly 12px of spare width to recover', async () => {
    const fixture = await mountToolbar(400)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    await fixture.resize(399)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[3])
    await fixture.resize(400)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[3])
    await fixture.resize(411)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[3])
    await fixture.resize(412)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    await fixture.resize(461)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    await fixture.resize(462)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[1])
  })

  it('reuses all measured levels across width-only changes and coalesces pending resize work', async () => {
    const fixture = await mountToolbar(190)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[7])
    const initialReads = { ...fixture.reads }
    expect(initialReads.leading).toBe(8)
    expect(initialReads.actions).toBe(8)

    fixture.geometry.width = 300
    fixture.notify([fixture.toolbar])
    fixture.geometry.width = 520
    fixture.notify([fixture.toolbar])
    expect(frames.size).toBe(1)
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[0])

    for (const [width, level] of [[499, 1], [312, 4], [199, 7], [160, 7], [450, 2], [461, 2], [462, 1], [512, 0]]) {
      await fixture.resize(width)
      expect(fixture.toolbar.dataset.compact).toBe(compactValues[level])
      fixture.notify()
      expect(frames.size).toBe(0)
    }
    expect(fixture.reads).toEqual(initialReads)
  })

  it.each(['leading', 'actions'] as const)('ignores subpixel %s notifications but reselects when intrinsic width changes', async (part) => {
    const fixture = await mountToolbar()
    fixture.notify()
    await flushFrame()
    const initialReads = { ...fixture.reads }
    fixture.geometry[part === 'leading' ? 'leadingExtra' : 'actionsExtra'] = 0.5
    fixture.notify([fixture[part]])
    expect(frames.size).toBe(0)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    expect(fixture.reads).toEqual(initialReads)

    fixture.geometry[part === 'leading' ? 'leadingExtra' : 'actionsExtra'] = 80
    fixture.notify([fixture[part]])
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[4])
    expect(fixture.reads.leading).toBeGreaterThan(initialReads.leading)
    expect(fixture.reads.actions).toBeGreaterThan(initialReads.actions)
    fixture.notify()
    expect(frames.size).toBe(0)
  })

  it('remeasures after text edits and child replacement rather than reusing stale content widths', async () => {
    const fixture = await mountToolbar()
    fixture.geometry.leadingExtra = 100
    fixture.leading.firstChild!.nodeValue = 'A longer workspace and model label'
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[4])
    expect(fixture.leading.textContent).toBe('A longer workspace and model label')

    fixture.geometry.leadingExtra = -100
    const label = document.createElement('span')
    label.textContent = 'Short'
    fixture.leading.replaceChildren(label)
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[0])
    expect(fixture.leading.textContent).toBe('Short')
  })

  it.each(['font', 'root-style'])('invalidates cached intrinsic widths on %s changes', async (trigger) => {
    const fixture = await mountToolbar()
    fixture.geometry.actionsExtra = 100
    if (trigger === 'font')
      fonts.dispatchEvent(new Event('loadingdone'))
    else
      document.documentElement.style.setProperty('--composer-layout-test-scale', '2')
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[4])
  })

  it('does not measure hidden content and reselects after showing with changed content', async () => {
    const fixture = await mountToolbar(0)
    expect(fixture.toolbar.dataset.compact).toBeUndefined()
    expect(fixture.reads.leading).toBe(0)
    expect(fixture.reads.actions).toBe(0)
    await fixture.resize(420)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    const visibleReads = { ...fixture.reads }

    fixture.geometry.width = 0
    fixture.notify()
    fixture.geometry.leadingExtra = 100
    fixture.leading.textContent = 'Changed while hidden'
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[2])
    expect(fixture.reads).toEqual(visibleReads)
    await fixture.resize(420)
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[4])
    expect(fixture.leading.textContent).toBe('Changed while hidden')
  })

  it('cancels pending layout and disconnects resize, mutation and font subscriptions on disposal', async () => {
    const fixture = await mountToolbar(190)
    const initialReads = { ...fixture.reads }
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[7])
    fixture.geometry.width = 520
    fixture.notify([fixture.toolbar])
    expect(frames.size).toBe(1)
    fixture.unmount()
    expect(frames.size).toBe(0)
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true)
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[7])

    fixture.geometry.width = 600
    fixture.notify()
    fixture.leading.textContent = 'Changed after disposal'
    document.documentElement.style.setProperty('--composer-layout-test-scale', '3')
    fonts.dispatchEvent(new Event('loadingdone'))
    await nextTick()
    expect(frames.size).toBe(0)
    await flushFrame()
    expect(fixture.toolbar.dataset.compact).toBe(compactValues[7])
    expect(fixture.reads).toEqual(initialReads)
  })
})
