// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { blockBrowserHistoryMouseButtons } from '../blockBrowserHistoryMouseButtons'

describe('blockBrowserHistoryMouseButtons', () => {
  it('cancels side-button mouseup before it can drive history', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const stop = blockBrowserHistoryMouseButtons()

    const back = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })
    const forward = new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true })
    const primary = new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true })
    target.dispatchEvent(back)
    target.dispatchEvent(forward)
    target.dispatchEvent(primary)

    expect(back.defaultPrevented).toBe(true)
    expect(forward.defaultPrevented).toBe(true)
    expect(primary.defaultPrevented).toBe(false)

    stop()
    const after = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })
    target.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    target.remove()
  })
})
