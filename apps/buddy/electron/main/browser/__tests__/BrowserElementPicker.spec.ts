import type { Input, MouseInputEvent } from 'electron'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { browserQuote } from '../../../../shared/browser/__tests__/browserSelectionFixture'
import { browserPickResultSchema } from '../../../../shared/browser/browserSelection'
import { BrowserDebugger } from '../BrowserDebugger'
import { BrowserElementPicker } from '../BrowserElementPicker'

function fixture(snapshot: unknown = { status: 'selected', text: browserQuote.text, element: browserQuote.element }) {
  const viewport = { clientWidth: 200, clientHeight: 100, pageX: 0, pageY: 0 }
  const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'main-frame' } } }
    if (method === 'DOM.getNodeForLocation')
      return browserQuote.element.locator
    if (method === 'Page.createIsolatedWorld')
      return { executionContextId: 1 }
    if (method === 'DOM.resolveNode')
      return { object: { objectId: 'element' } }
    if (method === 'Page.getLayoutMetrics')
      return { cssVisualViewport: viewport }
    if (method === 'Runtime.callFunctionOn')
      return { result: { value: snapshot } }
    return {}
  })
  const picker = new BrowserElementPicker(new BrowserDebugger({ attach: vi.fn(), detach: vi.fn(), isAttached: () => true, sendCommand }), () => 2)
  const mouse = (type: string) => ({ type, button: 'left', x: 100, y: 80 } as MouseInputEvent)
  return { picker, sendCommand, mouse, viewport }
}
describe('native browser element picker', () => {
  it.each([{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.1 }, { x: Number.NaN, y: 0.5 }, { x: 0.5, y: Number.POSITIVE_INFINITY }])('rejects an invalid transient menu anchor %j', (anchor) => {
    expect(browserPickResultSchema.safeParse({ status: 'selected', text: browserQuote.text, element: browserQuote.element, source: browserQuote.source, anchor }).success).toBe(false)
  })
  it('blocks down/up and context menu and returns a snapshot with zoom-normalized coordinates', async () => {
    const f = fixture()
    const pending = f.picker.start('request')
    expect(f.picker.handleMouse(f.mouse('mouseMove'), () => browserQuote.source)).toBe(false)
    expect(f.picker.handleMouse(f.mouse('contextMenu'), () => browserQuote.source)).toBe(true)
    expect(f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)).toBe(true)
    expect(await pending).toEqual({ status: 'selected', text: browserQuote.text, element: browserQuote.element, source: browserQuote.source, anchor: { x: 0.25, y: 0.4 } })
    expect(f.sendCommand).toHaveBeenCalledWith('DOM.getNodeForLocation', { x: 50, y: 40 })
    expect(f.picker.handleMouse(f.mouse('mouseUp'), () => browserQuote.source)).toBe(true)
    expect(f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)).toBe(false)
    f.picker.dispose()
  })
  it('keeps the last pointer position when hit testing is slower than pointer movement', async () => {
    const f = fixture()
    const hit = deferred<void>()
    const send = f.sendCommand.getMockImplementation()!
    const points: unknown[] = []
    f.sendCommand.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'DOM.getNodeForLocation') {
        points.push(params)
        if (points.length === 1)
          await hit.promise
      }
      return send(method)
    })
    const pending = f.picker.start('request')
    f.picker.handleMouse(f.mouse('mouseMove'), () => browserQuote.source)
    await vi.waitFor(() => expect(points).toHaveLength(1))
    f.picker.handleMouse({ ...f.mouse('mouseMove'), x: 120, y: 100 }, () => browserQuote.source)
    f.picker.handleMouse({ ...f.mouse('mouseMove'), x: 180, y: 140 }, () => browserQuote.source)
    hit.resolve()
    await vi.waitFor(() => expect(points).toEqual([{ x: 50, y: 40 }, { x: 90, y: 70 }]))
    f.picker.cancel()
    expect(await pending).toEqual({ status: 'cancelled' })
    f.picker.dispose()
  })
  it('uses document coordinates for hover and selection while keeping the menu anchored in the viewport', async () => {
    const f = fixture()
    Object.assign(f.viewport, { pageX: 75.25, pageY: 400.25 })
    const pending = f.picker.start('request')
    f.picker.handleMouse({ ...f.mouse('mouseMove'), x: 100.6, y: 80.6 }, () => browserQuote.source)
    await vi.waitFor(() => expect(f.sendCommand).toHaveBeenCalledWith('DOM.getNodeForLocation', { x: 126, y: 441 }))
    f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)
    expect(await pending).toMatchObject({ status: 'selected', anchor: { x: 0.25, y: 0.4 } })
    expect(f.sendCommand).toHaveBeenCalledWith('DOM.getNodeForLocation', { x: 125, y: 440 })
    f.picker.dispose()
  })
  it('cancels with Esc and only the matching token; late cancellation cannot cancel a new run', async () => {
    const f = fixture()
    const first = f.picker.start('first')
    const second = f.picker.start('second')
    expect(await first).toEqual({ status: 'cancelled' })
    f.picker.cancel('first')
    expect(f.picker.handleKey({ key: 'Enter' } as Input)).toBe(true)
    expect(f.picker.handleKey({ key: 'Escape' } as Input)).toBe(true)
    expect(await second).toEqual({ status: 'cancelled' })
    expect(f.picker.handleKey({ key: 'Enter' } as Input)).toBe(false)
    f.picker.dispose()
  })
  it('rejects malformed page results and cancels on dispose', async () => {
    const f = fixture({ status: 'selected', text: 'x', element: {} })
    const pending = f.picker.start('request')
    f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)
    expect(await pending).toEqual({ status: 'unavailable' })
    const next = f.picker.start('next')
    f.picker.dispose()
    expect(await next).toEqual({ status: 'cancelled' })
  })
})
