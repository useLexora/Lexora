import type { DesktopBrowserApi } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { watch } from 'vue'

export function useBrowserSurface(options: {
  api: Pick<DesktopBrowserApi, 'setSurface'>
  guestHost: DesktopBrowserGuestSurfaceHost
  sessionId: Readonly<Ref<string | null>>
  element: Readonly<Ref<HTMLElement | null>>
  visible?: Readonly<Ref<boolean>>
}) {
  watch([options.sessionId, options.element, () => options.visible?.value ?? true], async ([sessionId, element, visible], _previous, onCleanup) => {
    if (!sessionId || !element || !visible)
      return
    let active = true
    onCleanup(() => {
      active = false
      options.guestHost.hide(sessionId, element)
      void options.api.setSurface({ sessionId, visible: false }).catch(() => {})
    })
    options.guestHost.show(sessionId, element)
    try {
      await options.api.setSurface({ sessionId, visible: true })
    }
    catch {
      if (active)
        options.guestHost.hide(sessionId, element)
    }
  }, { immediate: true, flush: 'post' })
}
