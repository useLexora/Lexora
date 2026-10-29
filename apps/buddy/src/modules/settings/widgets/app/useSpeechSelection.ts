import type { SpeechKind } from '@buddy-shared/speech/speechApi'
import { shallowRef } from 'vue'
import { useSpeechCatalog } from '@/modules/speech'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

export function useSpeechSelection() {
  const { catalog, selected, refresh } = useSpeechCatalog()
  const selecting = shallowRef(false)
  const error = shallowRef('')
  async function select(kind: SpeechKind, id: string) {
    const provider = catalog.value.providers.find(item => item.kind === kind && item.id === id)
    if (!provider || selecting.value)
      return
    selecting.value = true
    error.value = ''
    try {
      await requireDesktopApi().speech.select({ kind, provider: { id, revision: provider.revision } })
      await refresh()
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : 'SPEECH_FAILED' }
    finally { selecting.value = false }
  }
  return { selected, select, selecting, error }
}
