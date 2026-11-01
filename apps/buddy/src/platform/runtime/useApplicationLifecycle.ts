import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { ApplicationStartupState } from '@buddy-shared/diagnostics/applicationStartup'
import { onScopeDispose, shallowRef } from 'vue'

export function useApplicationLifecycle(api: LexoraDesktopApi['app']['startup']) {
  const state = shallowRef<ApplicationStartupState>({
    revision: -1,
    generation: null,
    maintenance: null,
    hasBeenReady: false,
    status: 'starting',
    stages: [],
  })
  let disposed = false
  const accept = (next: ApplicationStartupState) => {
    if (!disposed && next.revision > state.value.revision)
      state.value = next
  }
  const unsubscribe = api.onStateChanged(accept)
  const refresh = () => api.getState().then(accept)
  const loaded = refresh()
  onScopeDispose(() => {
    disposed = true
    unsubscribe()
  })
  return { state, loaded, refresh }
}
