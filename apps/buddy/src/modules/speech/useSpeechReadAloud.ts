import type { SpeechPreferences } from '@buddy-shared/speech/speechApi'
import { speechEnabled, speechOutput } from '@buddy-shared/speech/speechApi'
import { shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { SpeechPlayback } from './audio/SpeechPlayback'
import { SystemSpeechPlayback } from './audio/SystemSpeechPlayback'
import { SpeechConnection } from './SpeechConnection'
import { activateSpeechPlayback, clearSpeechPlayback, markSpeechPlaying } from './speechPlaybackState'
import { useSpeechLifetime, useSpeechScopeKey } from './speechScope'
import { speechText } from './speechText'
import { useSpeechCatalog } from './useSpeechCatalog'
import { stopSpeechRecording } from './useSpeechRecorder'

export function useSpeechReadAloud(options: { owner: () => string, text: () => string, language: () => string, preferences?: () => SpeechPreferences }) {
  const { catalog, selected } = useSpeechCatalog()
  const scope = useSpeechScopeKey()
  const busy = shallowRef(false)
  const error = shallowRef('')
  let connection: SpeechConnection | undefined
  let playback: SpeechPlayback | SystemSpeechPlayback | undefined
  let epoch = 0
  function stop() {
    epoch++
    playback?.stop()
    void connection?.cancel()
    connection = undefined
    playback = undefined
    busy.value = false
    clearSpeechPlayback(stop)
  }
  function reset() {
    stop()
    error.value = ''
  }
  useSpeechLifetime(stop)
  watch(() => [options.owner(), options.text()], stop)
  watch(() => speechEnabled(options.preferences?.() ?? catalog.value.preferences, 'speech.synthesize'), enabled => !enabled && stop())
  watch(catalog, () => {
    const provider = connection?.provider
    if (provider && !catalog.value.providers.some(item => item.id === provider.id && item.revision === provider.revision && item.supported)) {
      error.value = 'SPEECH_PROVIDER_UNAVAILABLE'
      stop()
    }
  })
  async function play() {
    stop()
    if (!speechEnabled(options.preferences?.() ?? catalog.value.preferences, 'speech.synthesize'))
      return
    error.value = ''
    const text = speechText(options.text())
    if (!text) {
      error.value = 'SPEECH_TEXT_EMPTY'
      return
    }
    stopSpeechRecording()
    activateSpeechPlayback({ owner: options.owner(), scope: scope.value, phase: 'preparing', stop })
    const current = ++epoch
    busy.value = true
    try {
      const preferences = options.preferences?.() ?? catalog.value.preferences
      if (speechOutput(preferences) === 'system') {
        const player = playback = new SystemSpeechPlayback()
        await player.play(text, { voice: preferences.systemVoice, rate: preferences.systemRate, language: options.language() }, () => markSpeechPlaying(stop))
      }
      else {
        const provider = selected('speech.synthesize')
        if (!provider?.supported)
          throw new Error('SPEECH_PROVIDER_UNAVAILABLE')
        const player = playback = new SpeechPlayback()
        const session = connection = new SpeechConnection(requireDesktopApi().speech, provider, text, (event, signal) => {
          if (event.type === 'audio') {
            markSpeechPlaying(stop)
            return player.append(event, signal)
          }
        })
        const result = await session.done
        if (current !== epoch)
          return
        if (result.status === 'failed')
          throw new Error(result.error)
        if (result.status === 'completed')
          await player.drain(session.abort.signal)
      }
    }
    catch (cause) {
      if (current === epoch)
        error.value = cause instanceof Error ? cause.message : 'SPEECH_FAILED'
    }
    finally {
      if (current === epoch)
        stop()
    }
  }
  return { busy, error, play, stop, reset }
}
