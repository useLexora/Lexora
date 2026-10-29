export function encodeSpeechWave(chunks: readonly Uint8Array[]): Uint8Array {
  const samples = chunks.reduce((sum, bytes) => sum + bytes.byteLength / 4, 0)
  const wave = new Uint8Array(44 + samples * 2)
  const view = new DataView(wave.buffer)
  const write = (offset: number, value: string) => wave.set(new TextEncoder().encode(value), offset)
  write(0, 'RIFF')
  view.setUint32(4, wave.length - 8, true)
  write(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    const input = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (let i = 0; i < input.byteLength; i += 4) {
      const value = Math.max(-1, Math.min(1, input.getFloat32(i, true)))
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      offset += 2
    }
  }
  return wave
}

export function decodeSpeechWave(bytes: Uint8Array): { sampleRate: number, samples: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4))
  const invalid = () => new Error('SPEECH_AUDIO_INVALID')
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw invalid()
  let sampleRate = 0
  let channels = 0
  let format = 0
  let bits = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = tag(offset)
    const length = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (name === 'fmt ') {
      if (length < 16 || start + length > bytes.length)
        throw invalid()
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      bits = view.getUint16(start + 14, true)
    }
    if (name === 'data') {
      const size = length === 0xFFFFFFFF ? bytes.length - start : length
      if (start + size > bytes.length || !size || size % (channels * bits / 8) || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000 || !((format === 1 && bits === 16) || (format === 3 && bits === 32)))
        throw invalid()
      const stride = bits / 8
      const count = size / stride / channels
      const samples = new Uint8Array(count * 4)
      const output = new DataView(samples.buffer)
      for (let i = 0; i < count; i++) {
        let value = 0
        for (let channel = 0; channel < channels; channel++) {
          const at = start + (i * channels + channel) * stride
          value += format === 1 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true)
        }
        if (!Number.isFinite(value))
          throw invalid()
        output.setFloat32(i * 4, Math.max(-1, Math.min(1, value / channels)), true)
      }
      return { sampleRate, samples }
    }
    offset = start + length + (length % 2)
  }
  throw invalid()
}
