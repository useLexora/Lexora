import type { SpeechCatalog, SpeechKind } from '@buddy-shared/speech/speechApi'
import { speechSelection } from '@buddy-shared/speech/speechApi'
import { createSharedComposable } from '@vueuse/core'
import { onScopeDispose, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

export const useSpeechCatalog = createSharedComposable(() => {
  const api = requireDesktopApi()
  const catalog = shallowRef<SpeechCatalog>({ providers: [], preferences: {} })
  let revision = 0
  const refresh = async () => {
    const request = ++revision
    const next = await api.speech.catalog()
    if (request === revision)
      catalog.value = next
  }
  const update = () => {
    void refresh().catch(() => {})
  }
  const changed = api.speech.onChanged(update)
  const settings = api.settings.onChanged(update)
  window.addEventListener('focus', update)
  onScopeDispose(() => {
    revision++
    changed()
    settings()
    window.removeEventListener('focus', update)
  })
  update()
  const selected = (kind: SpeechKind) => {
    const ref = speechSelection(catalog.value.preferences, kind)
    return catalog.value.providers.find(item => item.kind === kind && item.id === ref?.id)
  }
  return { catalog, refresh, selected }
})
