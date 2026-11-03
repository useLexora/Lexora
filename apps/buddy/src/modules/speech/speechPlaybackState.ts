import { shallowRef } from 'vue'

export type SpeechPlaybackPhase = 'preparing' | 'generating' | 'loading' | 'playing'
interface ActivePlayback { owner: string, scope: string | null, phase: SpeechPlaybackPhase, stop: () => void }
export const activeSpeechPlayback = shallowRef<ActivePlayback | null>(null)
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.isComposing && activeSpeechPlayback.value) {
    event.preventDefault()
    activeSpeechPlayback.value.stop()
  }
}
export function activateSpeechPlayback(playback: ActivePlayback): void {
  stopSpeechPlayback()
  activeSpeechPlayback.value = playback
  document.addEventListener('keydown', escape)
}
export function clearSpeechPlayback(stop: () => void): void {
  if (activeSpeechPlayback.value?.stop !== stop)
    return
  activeSpeechPlayback.value = null
  document.removeEventListener('keydown', escape)
}
export function stopSpeechPlayback(): void {
  activeSpeechPlayback.value?.stop()
}

export function setSpeechPlaybackPhase(stop: () => void, phase: SpeechPlaybackPhase): void {
  const current = activeSpeechPlayback.value
  if (current?.stop === stop && current.phase !== phase)
    activeSpeechPlayback.value = { ...current, phase }
}
