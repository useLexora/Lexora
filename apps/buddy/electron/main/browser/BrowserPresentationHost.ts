import type { BrowserWindow as ElectronWindow, WebContents } from 'electron'
import type { DesktopBrowserGuestDescriptor, DesktopBrowserPresentationInput } from '../../../shared/browser/browserDesktopApi'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, View, WebContentsView } from 'electron'

interface OwnedPage {
  view: WebContentsView
  clip: View
  displayed: boolean
}

export class BrowserPresentationHost {
  readonly #pages = new Map<string, OwnedPage>()
  #parking: ElectronWindow | null = null
  #window: ElectronWindow | null = null
  #token: string | null = null
  #unbind: (() => void) | null = null
  readonly #setSurface: (sessionId: string, visible: boolean) => void

  constructor(setSurface: (sessionId: string, visible: boolean) => void) {
    this.#setSurface = setSurface
  }

  createPage(descriptor: DesktopBrowserGuestDescriptor): WebContents {
    if (this.#pages.has(descriptor.sessionId))
      throw new Error('Browser page already exists')
    this.#parking ??= new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const view = new WebContentsView({ webPreferences: { partition: descriptor.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, backgroundThrottling: false } })
    const clip = new View()
    clip.addChildView(view)
    clip.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    this.#parking.contentView.addChildView(clip)
    const page = { view, clip, displayed: false }
    this.#pages.set(descriptor.sessionId, page)
    view.webContents.once('destroyed', () => {
      if (this.#pages.get(descriptor.sessionId) !== page)
        return
      this.#remove(page)
      this.#pages.delete(descriptor.sessionId)
    })
    return view.webContents
  }

  bindWindow(window: ElectronWindow): void {
    this.detachWindow()
    this.#window = window
    const contents = window.webContents
    const invalidate = () => this.#revoke()
    const closed = () => {
      if (this.#window !== window)
        return
      this.#token = null
      this.#unbind?.()
      this.#unbind = null
      this.#window = null
      for (const page of this.#pages.values())
        page.displayed = false
    }
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace)
        invalidate()
    }
    const closing = (event: { defaultPrevented: boolean }) => {
      if (!event.defaultPrevented)
        this.detachWindow()
    }
    window.on('close', closing)
    window.once('closed', closed)
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', invalidate)
    this.#unbind = () => {
      window.off('close', closing)
      window.off('closed', closed)
      contents.off('did-start-navigation', navigation)
      contents.off('render-process-gone', invalidate)
    }
  }

  acquire(window: ElectronWindow): string {
    if (this.#window !== window || window.isDestroyed())
      throw new Error('DESKTOP_REQUIRED')
    this.#revoke()
    this.#token = randomUUID()
    return this.#token
  }

  present(window: ElectronWindow, input: DesktopBrowserPresentationInput): Promise<string | null> {
    if (this.#window !== window || window.isDestroyed() || this.#token !== input.presentationId)
      throw new Error('BROWSER_PRESENTATION_EXPIRED')
    const page = this.#pages.get(input.sessionId)
    if (!page || page.view.webContents.isDestroyed())
      throw new Error('BROWSER_PAGE_FAILED')
    if (!input.visible) {
      const capture = page.displayed ? page.view.webContents.capturePage() : null
      this.hide(input.sessionId)
      return (capture ?? Promise.resolve(null)).catch(() => null).then(snapshot => this.#token === input.presentationId && this.#pages.get(input.sessionId) === page ? snapshot?.toDataURL() ?? null : null)
    }
    const zoom = window.webContents.getZoomFactor()
    const rounded = (value: number) => Math.round(value * zoom)
    const { bounds, clip } = input
    const content = window.getContentBounds()
    const x = Math.max(0, rounded(clip.x))
    const y = Math.max(0, rounded(clip.y))
    const width = Math.min(rounded(clip.width), content.width - x)
    const height = Math.min(rounded(clip.height), content.height - y)
    if (width <= 0 || height <= 0) {
      this.hide(input.sessionId)
      return Promise.resolve(null)
    }
    if (!page.displayed)
      this.#remove(page)
    page.clip.setBounds({ x, y, width, height })
    page.view.setBounds({ x: rounded(bounds.x) - x, y: rounded(bounds.y) - y, width: Math.max(1, rounded(bounds.width)), height: Math.max(1, rounded(bounds.height)) })
    if (!page.displayed)
      window.contentView.addChildView(page.clip)
    page.displayed = true
    this.#setSurface(input.sessionId, true)
    return Promise.resolve(null)
  }

  hide(sessionId: string): void {
    const page = this.#pages.get(sessionId)
    if (!page)
      return
    this.#remove(page)
    if (this.#parking && !this.#parking.isDestroyed())
      this.#parking.contentView.addChildView(page.clip)
    page.displayed = false
    this.#setSurface(sessionId, false)
  }

  detachWindow(): void {
    this.#revoke()
    this.#unbind?.()
    this.#unbind = null
    this.#window = null
  }

  dispose(): void {
    this.detachWindow()
    for (const page of this.#pages.values()) {
      this.#remove(page)
      if (!page.view.webContents.isDestroyed())
        page.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.#pages.clear()
    this.#parking?.destroy()
    this.#parking = null
  }

  #remove(page: OwnedPage): void {
    if (this.#window && !this.#window.isDestroyed()) {
      if (page.displayed && page.view.webContents.isFocused())
        this.#window.webContents.focus()
      this.#window.contentView.removeChildView(page.clip)
    }
    if (this.#parking && !this.#parking.isDestroyed())
      this.#parking.contentView.removeChildView(page.clip)
  }

  #revoke(): void {
    this.#token = null
    for (const sessionId of this.#pages.keys())
      this.hide(sessionId)
  }
}
