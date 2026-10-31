// @vitest-environment jsdom
import type { MermaidBlockNodeProps } from 'markstream-vue'
import { MermaidBlockNode, setMermaidLoader } from 'markstream-vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, h, nextTick } from 'vue'
import BuddyImagePreview from '../BuddyImagePreview.vue'
import { usePreviewWheelZoom } from '../usePreviewWheelZoom'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
  document.body.replaceChildren()
  document.body.style.overflow = ''
})

async function subscribe() {
  const scope = effectScope()
  scope.run(() => usePreviewWheelZoom())
  cleanups.push(() => scope.stop())
  await nextTick()
  return scope
}

function fixture(className = 'n-image-preview-container') {
  const overlay = document.createElement('div')
  overlay.className = className
  overlay.innerHTML = '<div><button class="mermaid-action-btn" data-preview-zoom="in"></button><button class="mermaid-action-btn" data-preview-zoom="out"></button></div><div class="content"><svg><path /></svg></div>'
  document.body.append(overlay)
  const buttons = overlay.querySelectorAll('button')
  const zoomIn = vi.fn()
  const zoomOut = vi.fn()
  buttons[0]!.addEventListener('click', zoomIn)
  buttons[1]!.addEventListener('click', zoomOut)
  return { overlay, content: overlay.querySelector('path')!, zoomIn, zoomOut }
}

function wheel(target: Element, deltaY: number, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options })
  target.dispatchEvent(event)
  return event
}

describe('preview wheel zoom', () => {
  it.each(['n-image-preview-container', 'mermaid-modal-panel'])('zooms only the active %s and blocks background scrolling', async (className) => {
    vi.useFakeTimers()
    await subscribe()
    const active = fixture(className)
    const other = fixture(className)
    const bubble = vi.fn()
    active.overlay.addEventListener('wheel', bubble)

    expect(wheel(active.content, -100).defaultPrevented).toBe(true)
    await nextTick()
    expect(active.zoomIn).toHaveBeenCalledTimes(1)
    expect(other.zoomIn).not.toHaveBeenCalled()
    expect(bubble).not.toHaveBeenCalled()

    // Changing direction starts a new gesture, still respecting the rate limit.
    vi.advanceTimersByTime(80)
    wheel(active.content, 100)
    expect(active.zoomOut).toHaveBeenCalledTimes(1)
  })

  it('leaves inline diagrams, ordinary content and unrelated image groups alone', async () => {
    await subscribe()
    for (const className of ['mermaid-preview-area', 'buddy-chat-markdown', 'n-image-preview-container']) {
      const { content, overlay, zoomIn } = fixture(className)
      if (className === 'n-image-preview-container')
        overlay.querySelectorAll('[data-preview-zoom]').forEach(button => button.removeAttribute('data-preview-zoom'))
      expect(wheel(content, -100).defaultPrevented).toBe(false)
      expect(wheel(content, -100, { ctrlKey: true }).defaultPrevented).toBe(false)
      expect(zoomIn).not.toHaveBeenCalled()
    }
  })

  it('ignores horizontal, shifted and zero-delta scrolling', async () => {
    await subscribe()
    const { content, zoomIn } = fixture()
    expect(wheel(content, 0).defaultPrevented).toBe(false)
    expect(wheel(content, -10, { deltaX: 100 }).defaultPrevented).toBe(false)
    expect(wheel(content, -100, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(zoomIn).not.toHaveBeenCalled()
  })

  it.each([{ deltaY: -3, deltaMode: 1 }, { deltaY: -1, deltaMode: 2 }])('normalizes deltaMode $deltaMode', async ({ deltaY, deltaMode }) => {
    await subscribe()
    const { content, zoomIn } = fixture()
    wheel(content, deltaY, { deltaMode })
    expect(zoomIn).toHaveBeenCalledTimes(1)
  })

  it('accumulates trackpad deltas, throttles bursts and discards stale/reversed motion', async () => {
    vi.useFakeTimers()
    await subscribe()
    const { content, zoomIn, zoomOut } = fixture()
    for (let i = 0; i < 3; i++)
      wheel(content, -10)
    expect(zoomIn).not.toHaveBeenCalled()
    wheel(content, -10)
    expect(zoomIn).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++)
      wheel(content, -100)
    expect(zoomIn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(80)
    wheel(content, 10)
    expect(zoomOut).not.toHaveBeenCalled()
    wheel(content, 30)
    expect(zoomOut).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(201)
    wheel(content, 30)
    expect(zoomOut).toHaveBeenCalledTimes(1)
  })

  it('shares a single listener and releases it when the last consumer unmounts', async () => {
    const first = await subscribe()
    const second = await subscribe()
    const { content, zoomIn, zoomOut } = fixture()
    wheel(content, -100)
    expect(zoomIn).toHaveBeenCalledTimes(1)
    first.stop()

    const other = fixture()
    wheel(other.content, 100)
    expect(other.zoomOut).toHaveBeenCalledTimes(1)
    second.stop()
    expect(wheel(content, 100).defaultPrevented).toBe(false)
    expect(zoomOut).not.toHaveBeenCalled()

    await subscribe()
    const reopened = fixture()
    wheel(reopened.content, -100)
    expect(reopened.zoomIn).toHaveBeenCalledTimes(1)
  })

  it('uses the real image preview toolbar and existing scale state', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({
      render: () => h(BuddyImagePreview, { language: 'zh-CN', sources: ['test.png'], show: true }),
    })
    app.mount(host)
    cleanups.push(() => app.unmount())
    await nextTick()

    const image = document.querySelector<HTMLImageElement>('.n-image-preview-container .n-image-preview')!
    expect(image).not.toBeNull()
    wheel(image, -100)
    await nextTick()
    expect(image.style.transform).toContain('scale(1.5)')
    document.querySelector<HTMLButtonElement>('[data-preview-zoom="out"]')!.click()
    expect(image.style.transform).toContain('scale(1)')
  })

  it('uses the real Mermaid modal toolbar without enabling inline wheel zoom', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    setMermaidLoader(async () => ({
      initialize() {},
      async parse() { return true },
      async render(id: string) {
        return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="100" height="50" /></svg>` }
      },
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({
      setup() {
        usePreviewWheelZoom()
        const node = { type: 'code_block', language: 'mermaid', code: 'graph TD; A-->B', raw: '' } as MermaidBlockNodeProps['node']
        return () => h(MermaidBlockNode, {
          node,
          loading: false,
          enableWheelZoom: false,
          renderDebounceMs: 0,
          contentStableDelayMs: 0,
        })
      },
    })
    app.mount(host)
    cleanups.push(() => app.unmount())

    await vi.waitFor(() => {
      const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open"], button[aria-label="打开"]')
      expect(open).not.toBeNull()
    }, { timeout: 5_000 })
    host.querySelector<HTMLButtonElement>('button[aria-label="Open"], button[aria-label="打开"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('.mermaid-modal-panel [data-mermaid-wrapper]')).not.toBeNull())
    const panel = document.querySelector('.mermaid-modal-panel')!
    const content = panel.querySelector('[data-mermaid-wrapper]')!
    const scale = panel.querySelectorAll('button')[2]!
    expect(wheel(content, -100).defaultPrevented).toBe(true)
    await nextTick()
    expect(scale.textContent).toContain('110%')
    panel.querySelectorAll('button')[1]!.click()
    await nextTick()
    expect(scale.textContent).toContain('100%')

    const inline = host.querySelector('.mermaid-preview-area')!
    expect(wheel(inline, -100).defaultPrevented).toBe(false)
    expect(wheel(inline, -100, { ctrlKey: true }).defaultPrevented).toBe(false)
    panel.querySelectorAll('button')[3]!.click()
    await nextTick()
    expect(wheel(inline, -100).defaultPrevented).toBe(false)
  })
})
