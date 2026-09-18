import type { ShallowRef } from 'vue'
import type { DesktopBrowserGuestSurfaceHost } from './browserGuestSurface'
import { shallowRef, watch } from 'vue'

export function useBrowserGuestHost(host: Readonly<ShallowRef<DesktopBrowserGuestSurfaceHost | null>>): DesktopBrowserGuestSurfaceHost {
  const surfaces = shallowRef(new Map<string, HTMLElement>())

  watch(host, (value) => {
    for (const [sessionId, element] of surfaces.value)
      value?.show(sessionId, element)
  })

  return {
    layout: () => host.value?.layout?.(),
    show(sessionId, element) {
      surfaces.value.set(sessionId, element)
      host.value?.show(sessionId, element)
    },
    hide(sessionId, element) {
      const surface = surfaces.value.get(sessionId)
      if (!surface || (element && surface !== element))
        return
      surfaces.value.delete(sessionId)
      host.value?.hide(sessionId, element)
    },
  }
}
