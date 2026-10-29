import type { SpeechPayload } from '@buddy-shared/speech/speechApi'

export class SpeechPlayback {
  readonly #context = new AudioContext()
  readonly #sources = new Set<AudioBufferSourceNode>()
  readonly #waiters = new Set<() => void>()
  #end = 0
  #closed = false
  constructor() { void this.#context.resume().catch(() => {}) }

  async append(event: Extract<SpeechPayload, { type: 'audio' }>, signal: AbortSignal): Promise<void> {
    const length = event.bytes.byteLength / 4
    if (length / event.sampleRate > 2)
      throw new Error('SPEECH_AUDIO_INVALID')
    while (!this.#closed && this.#end - this.#context.currentTime > 2) await this.#changed(signal)
    signal.throwIfAborted()
    if (this.#closed)
      throw new Error('SPEECH_CANCELLED')
    const buffer = this.#context.createBuffer(1, length, event.sampleRate)
    const values = buffer.getChannelData(0)
    const view = new DataView(event.bytes.buffer, event.bytes.byteOffset, event.bytes.byteLength)
    for (let i = 0;
      i < length;
      i++) values[i] = view.getFloat32(i * 4, true)
    const source = this.#context.createBufferSource()
    source.buffer = buffer
    source.connect(this.#context.destination)
    this.#sources.add(source)
    source.onended = () => {
      this.#sources.delete(source)
      source.disconnect()
      this.#notify()
    }
    const start = Math.max(this.#end, this.#context.currentTime + 0.02)
    this.#end = start + buffer.duration
    source.start(start)
    await this.#context.resume()
  }

  async drain(signal: AbortSignal): Promise<void> {
    while (!this.#closed && this.#sources.size) await this.#changed(signal)
    signal.throwIfAborted()
  }

  stop(): void {
    if (this.#closed)
      return
    this.#closed = true
    for (const source of this.#sources) {
      source.stop()
      source.disconnect()
      source.onended = null
    }
    this.#sources.clear()
    this.#notify()
    void this.#context.close().catch(() => {})
  }

  #notify() { for (const resolve of this.#waiters) resolve() }
  #changed(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const waiters = this.#waiters
    return new Promise((resolve, reject) => {
      const cancel = () => {
        cleanup()
        reject(signal.reason)
      }
      const finish = () => {
        cleanup()
        resolve()
      }
      function cleanup() {
        signal.removeEventListener('abort', cancel)
        waiters.delete(finish)
      }
      this.#waiters.add(finish)
      signal.addEventListener('abort', cancel, { once: true })
    })
  }
}
