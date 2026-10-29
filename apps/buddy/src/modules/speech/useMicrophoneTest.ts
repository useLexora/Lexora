import { shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { MicrophoneCapture } from './audio/MicrophoneCapture'
import { stopSpeechPlayback } from './speechPlaybackState'
import { useSpeechLifetime } from './speechScope'
import { stopSpeechRecording } from './useSpeechRecorder'

export function useMicrophoneTest() {
  const active = shallowRef(false)
  const level = shallowRef(0)
  const error = shallowRef('')
  let capture: MicrophoneCapture | undefined
  let abort: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  function stop() {
    abort?.abort()
    abort = undefined
    clearTimeout(timer)
    void capture?.stop(false)
    capture = undefined
    active.value = false
    level.value = 0
    void requireDesktopApi().speech.microphone(false).catch(() => {})
  }
  useSpeechLifetime(stop)
  async function start() {
    stopSpeechPlayback()
    stopSpeechRecording()
    stop()
    const request = abort = new AbortController()
    active.value = true
    error.value = ''
    try {
      await requireDesktopApi().speech.microphone(true)
      request.signal.throwIfAborted()
      const recorder = capture = new MicrophoneCapture(async (bytes) => {
        if (request.signal.aborted)
          return
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
        level.value = Math.min(100, Math.round(rms * 400))
      }, () => {
        error.value = 'permission'
        stop()
      })
      await recorder.start(request.signal)
      if (!request.signal.aborted)
        timer = setTimeout(stop, 10000)
    }
    catch {
      if (request.signal.aborted)
        return
      error.value = 'permission'
      stop()
    }
  }
  return { active, level, error, start, stop }
}
