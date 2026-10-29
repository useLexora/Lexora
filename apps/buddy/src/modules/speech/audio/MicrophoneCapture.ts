import captureUrl from './capture.worklet.js?no-inline&url'

export class MicrophoneCapture {
  #stream?: MediaStream
  #context?: AudioContext
  #node?: AudioWorkletNode
  #source?: MediaStreamAudioSourceNode
  #pending: Promise<void> = Promise.resolve()
  #queuedBytes = 0
  #closed = false
  #flushed?: () => void
  readonly write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>
  readonly failed: (error: unknown) => void
  readonly observe?: (level: number, durationMs: number) => void
  constructor(write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>, failed: (error: unknown) => void, observe?: (level: number, durationMs: number) => void) {
    this.write = write
    this.failed = failed
    this.observe = observe
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
    if (signal.aborted || this.#closed) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('SPEECH_CANCELLED')
    }
    this.#stream = stream
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!this.#closed)
          this.failed(new Error('SPEECH_DEVICE_LOST'))
      }, { once: true })
    }
    const context = this.#context = new AudioContext({ sampleRate: 16000 })
    if (context.sampleRate !== 16000)
      throw new Error('SPEECH_CAPTURE_FAILED')
    await context.audioWorklet.addModule(captureUrl)
    signal.throwIfAborted()
    if (this.#closed)
      return
    const node = this.#node = new AudioWorkletNode(context, 'lexora-speech-capture', { channelCount: 1, channelCountMode: 'explicit' })
    node.onprocessorerror = () => this.failed(new Error('SPEECH_CAPTURE_FAILED'))
    node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | null>) => {
      if (data === null) {
        this.#flushed?.()
        return
      }
      if (this.observe) {
        const samples = new Float32Array(data)
        const energy = samples.reduce((sum, sample) => sum + sample * sample, 0)
        this.observe(Math.sqrt(energy / samples.length), samples.length / 16)
      }
      const bytes = new Uint8Array(data)
      this.#queuedBytes += bytes.byteLength
      if (this.#queuedBytes > 128000) {
        this.failed(new Error('SPEECH_INPUT_OVERFLOW'))
        return
      }
      this.#pending = this.#pending.then(() => this.write(bytes)).finally(() => {
        this.#queuedBytes -= bytes.byteLength
      })
      void this.#pending.catch((error) => {
        if (!this.#closed)
          this.failed(error)
      })
    }
    this.#source = context.createMediaStreamSource(stream)
    this.#source.connect(node)
    node.connect(context.destination)
    await context.resume()
  }

  async stop(flush: boolean): Promise<void> {
    if (this.#closed)
      return
    this.#closed = true
    this.#stream?.getTracks().forEach(track => track.stop())
    try {
      if (flush && this.#node) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('SPEECH_CAPTURE_FAILED')), 1000)
          this.#flushed = () => {
            clearTimeout(timer)
            resolve()
          }
          this.#node!.port.postMessage('finish')
        })
        await this.#pending
      }
    }
    finally {
      this.#source?.disconnect()
      this.#node?.disconnect()
      if (this.#node) {
        this.#node.port.onmessage = null
        this.#node.port.close()
      }
      await this.#context?.close().catch(() => {})
    }
  }
}
