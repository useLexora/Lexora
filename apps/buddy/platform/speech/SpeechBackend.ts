import type { SpeechChoice, SpeechProvider } from '../../shared/speech/speechApi'
import type { JsonValue } from '../../shared/workbench/workbenchState'

export interface SpeechInvocation {
  id: string
  kind: SpeechProvider['kind']
  input: JsonValue
  chunks?: AsyncIterable<Uint8Array>
  signal: AbortSignal
  ready: () => void | Promise<void>
  event: (data: JsonValue, bytes: Uint8Array, signal: AbortSignal) => void | Promise<void>
}
export interface SpeechBackend {
  voices?: (provider: SpeechProvider) => Promise<SpeechChoice[]>
  list: () => Promise<SpeechProvider[]>
  onChanged?: (listener: () => void) => () => void
  prepare: (provider: SpeechProvider) => Promise<void>
  invoke: (provider: SpeechProvider, input: SpeechInvocation) => Promise<void>
}

export function waitForSpeech<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}
