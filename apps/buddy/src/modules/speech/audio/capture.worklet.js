class SpeechCapture extends globalThis.AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(1600)
    this.offset = 0
    this.stopped = false
    this.port.onmessage = () => {
      this.stopped = true
      this.flush()
      this.port.postMessage(null)
    }
  }

  flush() {
    if (!this.offset)
      return
    const chunk = this.samples.slice(0, this.offset)
    this.port.postMessage(chunk.buffer, [chunk.buffer])
    this.offset = 0
  }

  process(inputs) {
    if (this.stopped)
      return false
    const input = inputs[0]?.[0]
    if (input) {
      for (const sample of input) {
        this.samples[this.offset++] = Math.max(-1, Math.min(1, sample))
        if (this.offset === this.samples.length)
          this.flush()
      }
    }
    return true
  }
}
globalThis.registerProcessor('lexora-speech-capture', SpeechCapture)
