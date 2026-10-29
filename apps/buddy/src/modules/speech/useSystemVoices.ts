import { createSharedComposable } from '@vueuse/core'
import { onScopeDispose, shallowRef } from 'vue'
import { systemVoices } from './audio/SystemSpeechPlayback'

export const useSystemVoices = createSharedComposable(() => {
  const voices = shallowRef<SpeechSynthesisVoice[]>([])
  const refresh = () => {
    voices.value = systemVoices(window.speechSynthesis)
  }
  window.speechSynthesis?.addEventListener('voiceschanged', refresh)
  window.addEventListener('focus', refresh)
  refresh()
  onScopeDispose(() => {
    window.speechSynthesis?.removeEventListener('voiceschanged', refresh)
    window.removeEventListener('focus', refresh)
  })
  return { voices, refresh }
})
