import { Buffer } from 'node:buffer'

export function createBuiltinNotificationSound(id: 'bell' | 'drop'): Uint8Array {
  const sampleRate = 24_000
  const duration = id === 'bell' ? 0.9 : 0.6
  const samples = Math.round(sampleRate * duration)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) {
    const time = index / sampleRate
    const attack = Math.min(1, time / 0.012)
    const release = Math.min(1, (duration - time) / 0.08)
    const decay = Math.exp(-time * (id === 'bell' ? 5 : 8))
    const phase = 2 * Math.PI * (id === 'bell' ? 660 * time : 880 * time - 360 * time * time)
    const wave = id === 'bell' ? Math.sin(phase) * 0.75 + Math.sin(phase * 1.5) * 0.25 : Math.sin(phase)
    bytes.writeInt16LE(Math.round(wave * attack * release * decay * 0.35 * 32767), 44 + index * 2)
  }
  return bytes
}
