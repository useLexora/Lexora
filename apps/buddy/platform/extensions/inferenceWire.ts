import type { Readable, Writable } from 'node:stream'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import { Buffer } from 'node:buffer'
import { inferenceLimits } from '../../shared/extensions/extensionInference'

export interface InferenceFrame {
  type: string
  id?: string
  sequence?: number
  data?: JsonValue
}
export function inferenceFrame(message: InferenceFrame, bytes: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(message))
  if (json.length > inferenceLimits.controlBytes || bytes.length > inferenceLimits.chunkBytes)
    throw new Error('EXTENSION_INFERENCE_FRAME_LIMIT')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(json.length, 0)
  header.writeUInt32LE(bytes.length, 4)
  return Buffer.concat([header, json, bytes])
}
export function enqueueInferenceFrame(stream: Writable, message: InferenceFrame, bytes?: Uint8Array): Promise<void> {
  const frame = inferenceFrame(message, bytes)
  if (stream.destroyed || stream.writableEnded || stream.writableLength + frame.length > inferenceLimits.queuedBytes)
    throw new Error('EXTENSION_INFERENCE_CHANNEL_FULL')
  return new Promise((resolve, reject) => stream.write(frame, error => error ? reject(error) : resolve()))
}
export async function writeInferenceFrame(stream: Writable, message: InferenceFrame, bytes?: Uint8Array): Promise<void> {
  await enqueueInferenceFrame(stream, message, bytes)
}
export async function* readInferenceFrames(stream: Readable): AsyncGenerator<{ message: InferenceFrame, bytes: Uint8Array }> {
  let buffer: Buffer = Buffer.alloc(0)
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 8) {
      const control = buffer.readUInt32LE(0)
      const binary = buffer.readUInt32LE(4)
      if (!control || control > inferenceLimits.controlBytes || binary > inferenceLimits.chunkBytes)
        throw new Error('EXTENSION_INFERENCE_FRAME_LIMIT')
      const length = 8 + control + binary
      if (buffer.length < length)
        break
      const message: unknown = JSON.parse(buffer.subarray(8, 8 + control).toString('utf8'))
      if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string')
        throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
      const bytes = new Uint8Array(buffer.subarray(8 + control, length))
      buffer = buffer.subarray(length)
      yield { message: message as InferenceFrame, bytes }
    }
  }
  if (buffer.length)
    throw new Error('EXTENSION_INFERENCE_CHANNEL_TRUNCATED')
}
