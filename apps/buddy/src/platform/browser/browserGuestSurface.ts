export interface DesktopBrowserGuestSurfaceHost {
  hide: (sessionId: string, element?: HTMLElement) => void
  show: (sessionId: string, element: HTMLElement) => void
  layout?: () => void
}
