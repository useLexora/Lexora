import type { SpeechProvider } from '@buddy-shared/speech/speechApi'
import { speechEnabled } from '@buddy-shared/speech/speechApi'
import { computed, shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { MicrophoneCapture } from './audio/MicrophoneCapture'
import { SpeechConnection } from './SpeechConnection'
import { stopSpeechPlayback } from './speechPlaybackState'
import { useSpeechLifetime } from './speechScope'
import { useSpeechCatalog } from './useSpeechCatalog'

let activeRecording: (() => void) | undefined
export function stopSpeechRecording(): void {
  activeRecording?.()
}
export function useSpeechRecorder(options: { onTranscript?: (text: string) => void } = {}) {
  const state = shallowRef<'idle' | 'loading' | 'recording' | 'finishing' | 'review'>('idle')
  const text = shallowRef('')
  const error = shallowRef('')
  const levels = shallowRef<number[]>([])
  const elapsedMs = shallowRef(0)
  const busy = computed(() => ['loading', 'recording', 'finishing'].includes(state.value))
  let connection: SpeechConnection | undefined
  let capture: MicrophoneCapture | undefined
  let epoch = 0
  const { catalog } = useSpeechCatalog()
  watch(() => speechEnabled(catalog.value.preferences, 'speech.transcribe'), enabled => !enabled && cancel(false))
  watch(catalog, () => {
    const provider = connection?.provider
    if (provider && !catalog.value.providers.some(item => item.id === provider.id && item.revision === provider.revision && item.supported)) {
      error.value = 'SPEECH_PROVIDER_UNAVAILABLE'
      cancel(false)
    }
  })

  function cancel(clear = true) {
    epoch++
    void capture?.stop(false)
    void connection?.cancel()
    capture = undefined
    connection = undefined
    if (activeRecording === stop)
      activeRecording = undefined
    if (clear) {
      text.value = ''
      error.value = ''
      levels.value = []
      elapsedMs.value = 0
    }
    state.value = text.value ? 'review' : 'idle'
  }
  function stop() {
    cancel(false)
  }
  useSpeechLifetime(stop)

  async function start(provider: SpeechProvider) {
    if (!speechEnabled(catalog.value.preferences, 'speech.transcribe'))
      return
    stopSpeechPlayback()
    stopSpeechRecording()
    cancel()
    activeRecording = stop
    const current = ++epoch
    state.value = 'loading'
    const segments = new Map<string, string>()
    const api = requireDesktopApi().speech
    const session = connection = new SpeechConnection(api, provider, undefined, (event) => {
      if (current !== epoch || event.type !== 'transcript')
        return
      segments.set(event.segmentId, event.text)
      text.value = [...segments.values()].join('\n')
    })
    const fail = (cause: unknown) => {
      if (current !== epoch)
        return
      error.value = cause instanceof Error ? cause.name === 'NotAllowedError' ? 'permission' : cause.message : 'SPEECH_FAILED'
      cancel(false)
      if (text.value.trim())
        options.onTranscript?.(text.value)
    }
    void session.done.then((result) => {
      if (current !== epoch)
        return
      epoch++
      session.abort.abort(new Error('SPEECH_SESSION_ENDED'))
      if (result.status === 'failed')
        error.value = result.error ?? 'SPEECH_FAILED'
      void capture?.stop(false)
      capture = undefined
      connection = undefined
      if (activeRecording === stop)
        activeRecording = undefined
      state.value = result.status === 'cancelled' ? 'idle' : 'review'
      if (result.status !== 'cancelled' && text.value.trim())
        options.onTranscript?.(text.value)
    })
    try {
      await session.ready
      if (current !== epoch)
        return
      let sequence = 0
      const recorder = capture = new MicrophoneCapture(bytes => api.write({ id: session.id, sequence: sequence++, bytes }), fail, (level, durationMs) => {
        if (current !== epoch)
          return
        levels.value = [...levels.value.slice(-239), Math.min(1, Math.sqrt(level) * 2)]
        elapsedMs.value += durationMs
      })
      await recorder.start(session.abort.signal)
      if (current === epoch && !session.abort.signal.aborted)
        state.value = 'recording'
    }
    catch (cause) { fail(cause) }
  }

  async function finish() {
    if (state.value !== 'recording')
      return
    const current = epoch
    const session = connection
    state.value = 'finishing'
    try {
      await capture?.stop(true)
      if (current === epoch && session)
        await session.api.finish(session.id)
    }
    catch (cause) {
      if (current !== epoch)
        return
      error.value = cause instanceof Error ? cause.message : 'SPEECH_FAILED'
      cancel(false)
      if (text.value.trim())
        options.onTranscript?.(text.value)
    }
  }
  return { state, text, error, busy, levels, elapsedMs, start, finish, cancel }
}
