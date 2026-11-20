import type { Socket } from 'node:net'
import type { RuntimeMessageTransport } from '../../shared/runtime/rpcPeer'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT } from '../../shared/conversation/attachmentPolicy'
import { Emitter } from '../../shared/events/Emitter'
import { rpcRequestSchema } from '../../shared/runtime/runtimeProtocol'
import { SERVICE_CONNECTION_BYTES, SERVICE_FRAME_BYTES } from '../../shared/service/localServiceProtocol'

const maxPendingBinaryBytes = 2 * BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT
const binaryRequestHeader = z.object({
  binaryRequest: rpcRequestSchema.extend({ params: z.record(z.string(), z.unknown()) }),
  byteLength: z.number().int().nonnegative().max(BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT),
}).strict()

export class SocketFrames {
  readonly #socket: Socket
  readonly #messages = new Emitter<string>(() => this.close(new Error('SERVICE_FRAME_HANDLER_FAILED')))
  readonly #closed = new Emitter<Error>(() => {})
  readonly onFrame = this.#messages.event
  readonly onDidClose = this.#closed.event
  #buffer: Buffer = Buffer.alloc(0)
  #ended = false
  #paused = false
  #writingControlBytes = 0
  #writingBinaryBytes = 0
  #body: { bytes: Uint8Array, offset: number, deliver: (bytes: Uint8Array) => void } | null = null

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on('data', chunk => this.#receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    socket.once('error', () => this.close(new Error('SERVICE_CONNECTION_FAILED')))
    socket.once('close', () => this.close(new Error('SERVICE_CONNECTION_CLOSED')))
  }

  send(frame: string): boolean {
    if (this.#ended)
      return false
    const bytes = Buffer.byteLength(frame)
    if (frame.includes('\n') || bytes > SERVICE_FRAME_BYTES || this.#writingControlBytes + bytes > SERVICE_CONNECTION_BYTES) {
      this.close(new Error('SERVICE_FRAME_LIMIT'))
      return false
    }
    this.#writingControlBytes += bytes + 1
    this.#socket.write(`${frame}\n`, () => {
      this.#writingControlBytes -= bytes + 1
    })
    return true
  }

  pause(): void {
    this.#paused = true
    this.#socket.pause()
  }

  resume(): void {
    if (!this.#paused)
      return
    this.#paused = false
    this.#drain()
    this.#socket.resume()
  }

  transport(): RuntimeMessageTransport {
    return {
      postMessage: (message) => {
        if ('id' in message && 'method' in message && message.params && typeof message.params === 'object'
          && 'bytes' in message.params && message.params.bytes instanceof Uint8Array) {
          const { bytes, ...params } = message.params
          if (bytes.length > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT || this.#writingBinaryBytes + bytes.length > maxPendingBinaryBytes)
            throw new Error('SERVICE_BINARY_LIMIT')
          const header = { binaryRequest: { ...message, params }, byteLength: bytes.length }
          if (!this.send(JSON.stringify(header)))
            throw new Error('SERVICE_CONNECTION_CLOSED')
          this.#writingBinaryBytes += bytes.length
          this.#socket.write(Buffer.from(bytes), () => {
            this.#writingBinaryBytes -= bytes.length
          })
          return
        }
        if (!this.send(JSON.stringify(message)))
          throw new Error('SERVICE_CONNECTION_CLOSED')
      },
      subscribe: (listener) => {
        const subscription = this.onFrame((frame) => {
          const message = JSON.parse(frame)
          if (!message || typeof message !== 'object' || !('binaryRequest' in message)) {
            listener(message)
            return
          }
          const { binaryRequest, byteLength } = binaryRequestHeader.parse(message)
          const deliver = (bytes: Uint8Array) => listener({ ...binaryRequest, params: { ...binaryRequest.params, bytes } })
          const bytes = new Uint8Array(byteLength)
          if (byteLength === 0)
            deliver(bytes)
          else
            this.#body = { bytes, offset: 0, deliver }
        })
        this.resume()
        return subscription.dispose
      },
    }
  }

  close(reason = new Error('SERVICE_CONNECTION_CLOSED')): void {
    if (this.#ended)
      return
    this.#ended = true
    this.#buffer = Buffer.alloc(0)
    this.#body = null
    this.#socket.destroy()
    this.#closed.fire(reason)
    this.#closed.dispose()
    this.#messages.dispose()
  }

  #receive(chunk: Buffer): void {
    if (this.#ended)
      return
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    this.#drain()
  }

  #drain(): void {
    while (!this.#ended && !this.#paused && this.#buffer.length) {
      const body = this.#body
      if (body) {
        const count = this.#buffer.copy(body.bytes, body.offset)
        this.#buffer = this.#buffer.subarray(count)
        body.offset += count
        if (body.offset === body.bytes.length) {
          this.#body = null
          try {
            body.deliver(body.bytes)
          }
          catch {
            this.close(new Error('SERVICE_FRAME_HANDLER_FAILED'))
          }
        }
        continue
      }
      const index = this.#buffer.indexOf(10)
      if (index < 0) {
        if (this.#buffer.length > SERVICE_FRAME_BYTES)
          this.close(new Error('SERVICE_FRAME_LIMIT'))
        return
      }
      if (index === 0 || index > SERVICE_FRAME_BYTES) {
        this.close(new Error('SERVICE_FRAME_LIMIT'))
        return
      }
      const bytes = this.#buffer.subarray(0, index)
      this.#buffer = this.#buffer.subarray(index + 1)
      try {
        const frame = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        JSON.parse(frame)
        this.#messages.fire(frame)
      }
      catch {
        this.close(new Error('SERVICE_FRAME_INVALID'))
      }
    }
  }
}
