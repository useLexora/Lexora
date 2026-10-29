import type { SpeechEvent, SpeechPayload, SpeechStart } from '../../shared/speech/speechApi'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { SpeechInvocation } from './SpeechBackend'
import { speechAudioSchema, speechTranscriptSchema } from '../../shared/speech/speechApi'
import { waitForSpeech } from './SpeechBackend'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export function validateSpeechSamples(bytes: Uint8Array): void {
  if (!bytes.byteLength || bytes.byteLength > 256 * 1024 || bytes.byteLength % 4)
    throw new Error('SPEECH_AUDIO_INVALID')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0;
    i < view.byteLength;
    i += 4) {
    const sample = view.getFloat32(i, true)
    if (!Number.isFinite(sample) || Math.abs(sample) > 1)
      throw new Error('SPEECH_AUDIO_INVALID')
  }
}

export class SpeechSession {
  readonly abort = new AbortController()
  readonly #input: Array<{ bytes: Uint8Array, accepted: ReturnType<typeof deferred> }> = []
  readonly #segments = new Map<string, { revision: number, final: boolean, text: string }>()
  #wake = deferred()
  #ack?: { sequence: number, result: ReturnType<typeof deferred> }
  #inputEnded = false
  #inputSequence = 0
  #outputSequence = 0
  #audioSequence = 0
  #sampleRate?: number
  #inputBytes = 0
  #pendingBytes = 0
  #ready = false
  #completion: Promise<void> = Promise.resolve()
  readonly input: SpeechStart
  readonly send: (event: SpeechEvent) => void
  constructor(input: SpeechStart, send: (event: SpeechEvent) => void) {
    this.input = input
    this.send = send
  }

  get microphoneAllowed(): boolean {
    return this.input.kind === 'speech.transcribe' && this.#ready && !this.#inputEnded && !this.abort.signal.aborted
  }

  start(invoke: (input: SpeechInvocation) => Promise<void>): void {
    this.#completion = (async () => {
      let status: 'completed' | 'cancelled' | 'failed' = 'completed'
      let error: string | undefined
      const timeout = setTimeout(() => this.abort.abort(new Error('SPEECH_SESSION_TIMEOUT')), 10 * 60 * 1000)
      try {
        await invoke({
          id: this.input.id,
          kind: this.input.kind,
          input: this.input.kind === 'speech.transcribe' ? { sampleRate: 16000, channels: 1, sampleFormat: 'f32le' } : { text: this.input.text! },
          signal: this.abort.signal,
          chunks: this.input.kind === 'speech.transcribe' ? this.#audio() : undefined,
          ready: async () => {
            this.#ready = true
            await this.#deliver({ type: 'ready' })
          },
          event: (data, bytes, signal) => this.#event(data, bytes, signal),
        })
        this.abort.signal.throwIfAborted()
        if (this.input.kind === 'speech.transcribe' && (!this.#segments.size || [...this.#segments.values()].some(segment => !segment.final)))
          throw new Error('SPEECH_TRANSCRIPT_INCOMPLETE')
        if (this.input.kind === 'speech.synthesize' && !this.#audioSequence)
          throw new Error('SPEECH_AUDIO_EMPTY')
      }
      catch (cause) {
        const reason = this.abort.signal.aborted ? this.abort.signal.reason : cause
        status = reason instanceof Error && reason.message === 'SPEECH_CANCELLED' ? 'cancelled' : 'failed'
        error = reason instanceof Error && /^SPEECH_[A-Z_]+$/.test(reason.message) ? reason.message : 'SPEECH_FAILED'
      }
      finally {
        clearTimeout(timeout)
        this.abort.abort(new Error('SPEECH_SESSION_ENDED'))
        for (const chunk of this.#input.splice(0)) chunk.accepted.reject(this.abort.signal.reason)
        this.#wake.resolve()
        this.send({ id: this.input.id, type: 'ended', status, ...(error && status === 'failed' ? { error } : {}) })
      }
    })()
  }

  async write(sequence: number, bytes: Uint8Array): Promise<void> {
    try {
      if (!this.microphoneAllowed || sequence !== this.#inputSequence++)
        throw new Error('SPEECH_INPUT_INVALID')
      validateSpeechSamples(bytes)
      this.#pendingBytes += bytes.byteLength
      this.#inputBytes += bytes.byteLength
      if (this.#pendingBytes > 256 * 1024 || this.#inputBytes > 16000 * 4 * 600)
        throw new Error('SPEECH_INPUT_OVERFLOW')
      const accepted = deferred()
      this.#input.push({ bytes, accepted })
      this.#wake.resolve()
      await waitForSpeech(accepted.promise, this.abort.signal)
    }
    catch (error) {
      this.abort.abort(error)
      throw error
    }
  }

  finish(): void {
    this.#inputEnded = true
    this.#wake.resolve()
  }

  acknowledge(sequence: number): void {
    if (this.#ack?.sequence === sequence)
      this.#ack.result.resolve()
  }

  async cancel(): Promise<void> {
    this.abort.abort(new Error('SPEECH_CANCELLED'))
    this.#wake.resolve()
    await this.#completion
  }

  async* #audio(): AsyncGenerator<Uint8Array> {
    while (!this.abort.signal.aborted) {
      const chunk = this.#input.shift()
      if (chunk) {
        try {
          yield chunk.bytes
          chunk.accepted.resolve()
        }
        finally {
          this.#pendingBytes -= chunk.bytes.byteLength
          chunk.accepted.reject(new Error('SPEECH_SESSION_ENDED'))
        }
      }
      else if (this.#inputEnded) {
        return
      }
      else {
        this.#wake = deferred()
        await waitForSpeech(this.#wake.promise, this.abort.signal)
      }
    }
  }

  async #event(data: JsonValue, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (this.input.kind === 'speech.transcribe') {
      const event = speechTranscriptSchema.parse(data)
      const previous = this.#segments.get(event.segmentId)
      if (bytes.byteLength || (previous && (previous.final || previous.revision >= event.revision)))
        throw new Error('SPEECH_TRANSCRIPT_INVALID')
      this.#segments.set(event.segmentId, event)
      if (this.#segments.size > 256 || [...this.#segments.values()].reduce((sum, item) => sum + item.text.length, 0) > 16000)
        throw new Error('SPEECH_TRANSCRIPT_TOO_LONG')
      await this.#deliver(event, signal)
    }
    else {
      const event = speechAudioSchema.parse(data)
      if (event.sequence !== this.#audioSequence++ || (this.#sampleRate && event.sampleRate !== this.#sampleRate))
        throw new Error('SPEECH_AUDIO_SEQUENCE_INVALID')
      this.#sampleRate = event.sampleRate
      if (bytes.byteLength / 4 / event.sampleRate > 2)
        throw new Error('SPEECH_AUDIO_INVALID')
      validateSpeechSamples(bytes)
      await this.#deliver({ ...event, bytes }, signal)
    }
  }

  async #deliver(payload: SpeechPayload, lifetime?: AbortSignal): Promise<void> {
    const result = deferred()
    const sequence = this.#outputSequence++
    this.#ack = { sequence, result }
    const timer = setTimeout(() => result.reject(new Error('SPEECH_CONSUMER_TIMEOUT')), 30000)
    try {
      this.send({ id: this.input.id, type: 'event', sequence, payload })
      await waitForSpeech(result.promise, lifetime ? AbortSignal.any([this.abort.signal, lifetime]) : this.abort.signal)
    }
    finally {
      clearTimeout(timer)
      this.#ack = undefined
    }
  }
}
