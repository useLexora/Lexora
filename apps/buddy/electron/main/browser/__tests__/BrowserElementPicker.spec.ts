import type { Input, MouseInputEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { browserQuote } from '../../../../shared/browser/__tests__/browserSelectionFixture'
import { browserPickResultSchema } from '../../../../shared/browser/browserSelection'
import { BrowserDebugger } from '../BrowserDebugger'
import { BrowserElementPicker } from '../BrowserElementPicker'

function fixture() {
  let context = 0
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld')
      return { executionContextId: ++context }
    if (String(params?.expression).includes('.pick('))
      return { result: { value: { status: 'selected', text: browserQuote.text, element: browserQuote.element, anchor: { x: 0.25, y: 0.4 } } } }
    return { result: { type: 'undefined' } }
  })
  const picker = new BrowserElementPicker(new BrowserDebugger({ attach: vi.fn(), detach: vi.fn(), isAttached: () => true, sendCommand }), () => 2)
  const mouse = (type: string) => ({ type, button: 'left', x: 100, y: 80 } as MouseInputEvent)
  return { picker, sendCommand, mouse }
}
describe('native browser element picker', () => {
  it.each([{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.1 }, { x: Number.NaN, y: 0.5 }, { x: 0.5, y: Number.POSITIVE_INFINITY }])('rejects an invalid transient menu anchor %j', (anchor) => {
    expect(browserPickResultSchema.safeParse({ status: 'selected', text: browserQuote.text, element: browserQuote.element, source: browserQuote.source, anchor }).success).toBe(false)
  })
  it('blocks down/up and context menu, collects in an isolated world with zoom-normalized coordinates', async () => {
    const f = fixture()
    const pending = f.picker.start('request')
    await vi.waitFor(() => expect(f.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything()))
    expect(f.picker.handleMouse(f.mouse('mouseMove'), () => browserQuote.source)).toBe(false)
    expect(f.picker.handleMouse(f.mouse('contextMenu'), () => browserQuote.source)).toBe(true)
    expect(f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)).toBe(true)
    expect(await pending).toEqual({ status: 'selected', text: browserQuote.text, element: browserQuote.element, source: browserQuote.source, anchor: { x: 0.25, y: 0.4 } })
    expect(f.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: expect.stringContaining('.pick(50,40)') }))
    expect(f.picker.handleMouse(f.mouse('mouseUp'), () => browserQuote.source)).toBe(true)
    expect(f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)).toBe(false)
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
    const f = fixture()
    const pending = f.picker.start('request')
    await vi.waitFor(() => expect(f.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything()))
    f.sendCommand.mockImplementation(async () => ({ result: { value: { status: 'selected', text: 'x', element: {} } } }))
    f.picker.handleMouse(f.mouse('mouseDown'), () => browserQuote.source)
    expect(await pending).toEqual({ status: 'limit' })
    const next = f.picker.start('next')
    f.picker.dispose()
    expect(await next).toEqual({ status: 'cancelled' })
  })
})
