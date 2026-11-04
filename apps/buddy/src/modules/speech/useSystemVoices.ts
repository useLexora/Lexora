import { shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { systemVoices } from './audio/SystemSpeechPlayback'

export function useSystemVoices(enabled: () => boolean) {
  const voices = shallowRef<SpeechSynthesisVoice[]>([])
  let revision = 0
  let synthesis: SpeechSynthesis | undefined
  const read = () => {
    voices.value = systemVoices(synthesis)
  }
  const detach = () => {
    synthesis?.removeEventListener('voiceschanged', read)
    synthesis = undefined
    voices.value = []
  }
  const refresh = async () => {
    const request = ++revision
    const available = await requireDesktopApi().speech.prepareSystem().catch(() => false)
    if (request !== revision || !enabled())
      return
    if (!available) {
      detach()
      return
    }
    synthesis ??= window.speechSynthesis
    synthesis?.addEventListener('voiceschanged', read)
    read()
  }
  watch(enabled, (active, _, onCleanup) => {
    if (!active)
      return
    window.addEventListener('focus', refresh)
    void refresh()
    onCleanup(() => {
      revision++
      detach()
      window.removeEventListener('focus', refresh)
    })
  }, { immediate: true, flush: 'sync' })
  return { voices }
}
