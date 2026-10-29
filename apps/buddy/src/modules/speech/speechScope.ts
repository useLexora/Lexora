import type { InjectionKey } from 'vue'
import { createSharedComposable } from '@vueuse/core'
import { computed, inject, onScopeDispose, provide, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

interface SpeechScope { active: () => boolean, key: () => string }
const key: InjectionKey<SpeechScope> = Symbol('speechScope')
export function provideSpeechScope(scope: SpeechScope): void {
  provide(key, scope)
}
export function useSpeechScopeKey() {
  const scope = inject(key, undefined)
  return computed(() => scope?.key() ?? null)
}
const useWindowLifetime = createSharedComposable(() => {
  const stops = new Set<() => void>()
  const stop = () => {
    for (const listener of stops) listener()
  }
  const hidden = () => {
    if (document.hidden)
      stop()
  }
  document.addEventListener('visibilitychange', hidden)
  const releaseHidden = requireDesktopApi().app.onHidden(stop)
  const releaseQuit = requireDesktopApi().app.onBeforeQuit(async () => {
    stop()
    return true
  })
  onScopeDispose(() => {
    releaseHidden()
    releaseQuit()
    document.removeEventListener('visibilitychange', hidden)
  })
  return stops
})
export function useSpeechLifetime(stop: () => void): void {
  const scope = inject(key, undefined)
  if (scope)
    watch(() => [scope.active(), scope.key()], stop)
  const stops = useWindowLifetime()
  stops.add(stop)
  onScopeDispose(() => {
    stop()
    stops.delete(stop)
  })
}
