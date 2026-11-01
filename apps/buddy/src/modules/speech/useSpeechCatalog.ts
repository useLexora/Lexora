import type { SpeechCatalog, SpeechKind } from '@buddy-shared/speech/speechApi'
import { speechSelection } from '@buddy-shared/speech/speechApi'
import { createSharedComposable } from '@vueuse/core'
import { onScopeDispose, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

// 共享状态在最后一个使用方卸载（如新建对话时输入框重建）后会销毁；缓存上一次结果，避免重建时短暂回到“默认全部开启”。
let lastCatalog: SpeechCatalog | undefined

export const useSpeechCatalog = createSharedComposable(() => {
  const api = requireDesktopApi()
  const catalog = shallowRef<SpeechCatalog>(lastCatalog ?? { providers: [], preferences: {} })
  const loaded = shallowRef(!!lastCatalog)
  let revision = 0
  const refresh = async () => {
    const request = ++revision
    lastCatalog = undefined
    const next = await api.speech.catalog()
    if (request === revision) {
      lastCatalog = next
      catalog.value = next
      loaded.value = true
    }
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
  return { catalog, loaded, refresh, selected }
})
