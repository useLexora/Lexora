import type { ShallowRef } from 'vue'
import type { BrowserGuestSurface, DesktopBrowserGuestSurfaceHost } from './browserGuestSurface'
import { watch } from 'vue'

export function useBrowserGuestHost(host: Readonly<ShallowRef<DesktopBrowserGuestSurfaceHost | null>>): DesktopBrowserGuestSurfaceHost {
  const surfaces = new Map<string, BrowserGuestSurface>()

  watch(host, (value) => {
    for (const [sessionId, surface] of surfaces)
      value?.show(sessionId, surface)
  })

  return {
    layout: () => host.value?.layout?.(),
    show(sessionId, surface) {
      surfaces.set(sessionId, surface)
      host.value?.show(sessionId, surface)
    },
    hide(sessionId, surface) {
      if (surfaces.get(sessionId) !== surface)
        return
      surfaces.delete(sessionId)
      host.value?.hide(sessionId, surface)
    },
  }
}
