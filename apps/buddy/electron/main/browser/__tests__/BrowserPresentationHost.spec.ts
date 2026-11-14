import { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { BrowserPresentationHost } from '../BrowserPresentationHost'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class View {
    children: View[] = []
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    addChildView(view: View) {
      this.removeChildView(view)
      this.children.push(view)
    }

    removeChildView(view: View) { this.children = this.children.filter(child => child !== view) }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
  }
  class Contents extends EventEmitter {
    destroyed = false
    isDestroyed() { return this.destroyed }
    isFocused() { return false }
    focus() {}
    getZoomFactor() { return 1.25 }
    capturePage() { return Promise.resolve({ toDataURL: () => 'data:image/png;base64,c2NyZWVuc2hvdA==' }) }
    close() {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  class Window extends EventEmitter {
    readonly contentView = new View()
    readonly webContents = new Contents()
    destroyed = false
    isDestroyed() { return this.destroyed }
    getContentBounds() { return { x: 0, y: 0, width: 1000, height: 800 } }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return { BrowserWindow: Window, View, WebContentsView: class extends View { readonly webContents = new Contents() } }
})

function input(presentationId: string) {
  return { presentationId, sessionId: 'session', pageId: 'page', visible: true, bounds: { x: 10, y: 20, width: 400, height: 300 }, clip: { x: 20, y: 30, width: 300, height: 200 } }
}

describe('browser presentation ownership', () => {
  it('preserves the page through window close and rejects the old display token in a new window', async () => {
    const host = new BrowserPresentationHost(() => {})
    const page = host.createPage({ sessionId: 'session', partition: 'persist:isolated-fixture' })
    const first = new BrowserWindow()
    host.bindWindow(first)
    const token = host.acquire(first)
    await host.present(first, input(token))
    expect(first.contentView.children).toHaveLength(1)
    first.destroy()
    expect(page.isDestroyed()).toBe(false)
    const second = new BrowserWindow()
    host.bindWindow(second)
    expect(() => host.present(second, input(token))).toThrow('BROWSER_PRESENTATION_EXPIRED')
    await host.present(second, input(host.acquire(second)))
    expect(second.contentView.children).toHaveLength(1)
    expect(page.isDestroyed()).toBe(false)
    host.dispose()
    expect(page.isDestroyed()).toBe(true)
  })

  it('revokes renderer generations without closing pages and preserves clipped viewport geometry', async () => {
    const host = new BrowserPresentationHost(() => {})
    const page = host.createPage({ sessionId: 'session', partition: 'persist:isolated-fixture' })
    const window = new BrowserWindow()
    host.bindWindow(window)
    const token = host.acquire(window)
    await host.present(window, input(token))
    const clip = window.contentView.children[0]!
    expect(clip.getBounds()).toEqual({ x: 25, y: 38, width: 375, height: 250 })
    expect(clip.children[0]!.getBounds()).toEqual({ x: -12, y: -13, width: 500, height: 375 })
    window.webContents.emit('did-start-navigation', {}, 'lexora-app://desktop/index.html', false, true)
    expect(window.contentView.children).toHaveLength(0)
    expect(page.isDestroyed()).toBe(false)
    expect(() => host.present(window, input(token))).toThrow('BROWSER_PRESENTATION_EXPIRED')
    const next = host.acquire(window)
    await host.present(window, input(next))
    expect(await host.present(window, { ...input(next), visible: false })).toMatch(/^data:image\/png/)
    expect(window.contentView.children).toHaveLength(0)
    expect(page.isDestroyed()).toBe(false)
    host.dispose()
  })
})
