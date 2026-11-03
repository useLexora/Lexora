// @vitest-environment jsdom
import type { WorkbenchSplit } from '../../common/workbench'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { useWorkbenchResize } from '../useWorkbenchResize'

const cleanups: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
})

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function fixture() {
  const registry = new ContributionRegistry()
  registry.register('sample', scope => scope.view({ id: 'sample', renderer: 'sample', locations: ['main'], label: 'Sample', multiple: true, supports: resource => resource.scheme === 'sample' }))
  const controller = new WorkbenchController(registry)
  await controller.open({ scheme: 'sample', id: 'first', data: {} }, 'First')
  await controller.open({ scheme: 'sample', id: 'second', data: {} }, 'Second', { direction: 'right' })
  await controller.open({ scheme: 'sample', id: 'third', data: {} }, 'Third', { direction: 'down' })
  const horizontal = () => controller.layout.root as WorkbenchSplit
  const vertical = () => horizontal().second as WorkbenchSplit
  const scope = effectScope()
  const resize = scope.run(() => useWorkbenchResize(controller))!
  const element = document.createElement('div')
  document.body.append(element)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 1001, height: 501 } as DOMRect)
  let captured = false
  element.setPointerCapture = () => {
    captured = true
  }
  element.hasPointerCapture = () => captured
  element.releasePointerCapture = () => {
    captured = false
  }
  const unregister = resize.register(horizontal().id, element, horizontal)
  resize.register(vertical().id, element, vertical)
  const revisions: number[] = []
  const unsubscribe = controller.onDidChangeLayout(change => revisions.push(change.revision))
  function pointer(type: string, x: number, y = 0, pointerId = 1) {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    return event as PointerEvent
  }
  function begin(both = false) {
    const event = pointer('pointerdown', 0)
    Object.defineProperty(event, 'currentTarget', { value: element })
    resize.begin(both ? [horizontal().id, vertical().id] : [horizontal().id], event)
  }
  const move = (x: number, y = 0, id = 1) => window.dispatchEvent(pointer('pointermove', x, y, id))
  const up = (x: number, y = 0, id = 1) => window.dispatchEvent(pointer('pointerup', x, y, id))
  cleanups.push(() => {
    scope.stop()
    unsubscribe.dispose()
    controller.dispose()
    element.remove()
  })
  return { resize, horizontal, vertical, element, scope, revisions, begin, move, up, pointer, unregister }
}

describe('workbench resizing', () => {
  it('coalesces both axes to one layout revision per frame using the latest pointer', async () => {
    const f = await fixture()
    f.begin(true)
    for (let x = 1; x <= 100; x++)
      f.move(x, x)
    expect(f.horizontal().ratio).toBe(0.5)
    expect(f.vertical().ratio).toBe(0.5)
    expect(f.revisions).toHaveLength(0)
    vi.advanceTimersToNextFrame()
    expect(f.horizontal().ratio).toBeCloseTo(0.6)
    expect(f.vertical().ratio).toBeCloseTo(0.7)
    expect(f.revisions).toHaveLength(1)
    f.move(200, 50)
    vi.advanceTimersToNextFrame()
    expect(f.horizontal().ratio).toBeCloseTo(0.7)
    expect(f.vertical().ratio).toBeCloseTo(0.6)
    expect(f.revisions).toHaveLength(2)
  })

  it('commits the release coordinates before the scheduled frame and keeps size limits', async () => {
    const f = await fixture()
    f.begin()
    f.move(100)
    f.up(200)
    expect(f.horizontal().ratio).toBeCloseTo(0.7)
    expect(f.resize.active.value).toEqual([])
    expect(f.element.hasPointerCapture(1)).toBe(false)
    vi.advanceTimersToNextFrame()
    expect(f.revisions).toHaveLength(1)
    f.begin()
    f.up(2000)
    expect(f.horizontal().ratio).toBe(0.85)
  })

  it.each(['Escape', 'pointercancel'])('restores both initial ratios on %s without replaying pending work', async (reason) => {
    const f = await fixture()
    f.begin(true)
    f.move(100, 100)
    vi.advanceTimersToNextFrame()
    f.move(200, 150)
    window.dispatchEvent(reason === 'Escape' ? new KeyboardEvent('keydown', { key: 'Escape' }) : f.pointer('pointercancel', 200, 150))
    expect(f.horizontal().ratio).toBe(0.5)
    expect(f.vertical().ratio).toBe(0.5)
    expect(f.resize.active.value).toEqual([])
    vi.advanceTimersToNextFrame()
    expect(f.horizontal().ratio).toBe(0.5)
    expect(f.vertical().ratio).toBe(0.5)
    f.move(250, 200)
    vi.advanceTimersToNextFrame()
    expect(f.revisions).toHaveLength(2)
  })

  it('ignores other pointers and retains the owning drag', async () => {
    const f = await fixture()
    f.begin()
    f.move(200, 0, 2)
    f.up(200, 0, 2)
    window.dispatchEvent(f.pointer('pointercancel', 200, 0, 2))
    vi.advanceTimersToNextFrame()
    expect(f.horizontal().ratio).toBe(0.5)
    expect(f.resize.active.value).toEqual([f.horizontal().id])
    f.up(100)
    expect(f.horizontal().ratio).toBeCloseTo(0.6)
  })

  it.each(['blur', 'lostpointercapture', 'unregister', 'dispose'])('finishes the pending position on %s and releases listeners', async (reason) => {
    const f = await fixture()
    f.begin()
    f.move(100)
    if (reason === 'unregister')
      f.unregister()
    else if (reason === 'dispose')
      f.scope.stop()
    else (reason === 'blur' ? window : f.element).dispatchEvent(new Event(reason))
    expect(f.horizontal().ratio).toBeCloseTo(0.6)
    expect(f.resize.active.value).toEqual([])
    f.move(200)
    vi.advanceTimersToNextFrame()
    expect(f.horizontal().ratio).toBeCloseTo(0.6)
    expect(f.revisions).toHaveLength(1)
  })
})
