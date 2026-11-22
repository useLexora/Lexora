export interface BrowserGuestSurface {
  element: HTMLElement
  pageId: string
  onPresented: () => void
}

export interface DesktopBrowserGuestSurfaceHost {
  hide: (sessionId: string, surface: BrowserGuestSurface) => void
  show: (sessionId: string, surface: BrowserGuestSurface) => void
  layout?: () => void
}
