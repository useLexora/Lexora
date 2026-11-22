import type { Ref } from 'vue'
import type { BrowserGuestSurface, DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { readonly, shallowRef, watch } from 'vue'

export function useBrowserSurface(options: {
  guestHost: DesktopBrowserGuestSurfaceHost
  sessionId: Readonly<Ref<string | null>>
  pageId: Readonly<Ref<string | null>>
  element: Readonly<Ref<HTMLElement | null>>
  visible?: Readonly<Ref<boolean>>
}) {
  const presented = shallowRef(false)
  watch([options.sessionId, options.pageId, options.element, () => options.visible?.value ?? true], ([sessionId, pageId, element, visible], _, onCleanup) => {
    if (!sessionId || !pageId || !element || !visible)
      return
    let current = true
    const surface: BrowserGuestSurface = { pageId, element, onPresented: () => {
      if (current)
        presented.value = true
    } }
    onCleanup(() => {
      current = false
      presented.value = false
      options.guestHost.hide(sessionId, surface)
    })
    options.guestHost.show(sessionId, surface)
  }, { immediate: true, flush: 'sync' })
  return readonly(presented)
}
