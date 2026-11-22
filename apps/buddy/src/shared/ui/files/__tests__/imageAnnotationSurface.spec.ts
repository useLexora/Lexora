// @vitest-environment jsdom
import type { AnnotationHistoryCommand } from '../imageAnnotation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, ref } from 'vue'
import ImageAnnotationSurface from '../ImageAnnotationSurface.vue'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length)
    cleanups.pop()?.()
  document.body.replaceChildren()
})

function box() {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON() {
      return {}
    },
  }
}

function mountSurface(disabled = false) {
  const commands: AnnotationHistoryCommand[] = []
  const host = document.createElement('div')
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { get: () => 100 })
  Object.defineProperty(image, 'naturalHeight', { get: () => 100 })
  image.getBoundingClientRect = box
  host.getBoundingClientRect = box
  host.append(image)
  const root = document.createElement('div')
  document.body.append(host, root)
  const unavailable = ref(disabled)
  const app = createApp({
    setup: () => () => h(ImageAnnotationSurface, {
      image,
      rects: [],
      disabled: unavailable.value,
      label: 'Annotate',
      onHistory: (command: AnnotationHistoryCommand) => commands.push(command),
    }),
  })
  app.mount(root)
  cleanups.push(() => app.unmount())
  const surface = root.querySelector('[data-testid="image-annotation-surface"]')
  if (!(surface instanceof SVGElement))
    throw new Error('annotation surface missing')
  return { commands, surface, unavailable }
}

function press(target: EventTarget, key: string, modifiers: { ctrl?: boolean, meta?: boolean, shift?: boolean, alt?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: !!modifiers.ctrl,
    metaKey: !!modifiers.meta,
    shiftKey: !!modifiers.shift,
    altKey: !!modifiers.alt,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

describe('image annotation surface shortcuts', () => {
  it('handles undo and redo only while the annotation surface is focused', () => {
    const { commands, surface } = mountSurface()
    const reachedWindow = vi.fn()
    window.addEventListener('keydown', reachedWindow)
    cleanups.push(() => window.removeEventListener('keydown', reachedWindow))
    surface.focus()
    expect(press(surface, 'z', { ctrl: true }).defaultPrevented).toBe(true)
    expect(press(surface, 'z', { meta: true, shift: true }).defaultPrevented).toBe(true)
    expect(press(surface, 'y', { ctrl: true }).defaultPrevented).toBe(true)
    expect(commands).toEqual(['undo', 'redo', 'redo'])
    expect(reachedWindow).not.toHaveBeenCalled()

    const field = document.createElement('textarea')
    document.body.append(field)
    field.focus()
    expect(press(field, 'z', { ctrl: true }).defaultPrevented).toBe(false)
    expect(press(window, 'y', { ctrl: true }).defaultPrevented).toBe(false)
    expect(commands).toEqual(['undo', 'redo', 'redo'])
    expect(reachedWindow).toHaveBeenCalledTimes(2)
  })

  it('keeps the shortcut from reaching the page while quoting is busy', () => {
    const { commands, surface } = mountSurface(true)
    surface.focus()
    expect(press(surface, 'z', { ctrl: true }).defaultPrevented).toBe(true)
    expect(press(surface, 'z', { alt: true, ctrl: true }).defaultPrevented).toBe(false)
    expect(commands).toEqual([])
  })
})
