import type { Socket } from 'node:net'
import type { RuntimeMessageTransport } from '../../shared/runtime/rpcPeer'
import { Buffer } from 'node:buffer'
import { Emitter } from '../../shared/events/Emitter'
import { SERVICE_CONNECTION_BYTES, SERVICE_FRAME_BYTES } from '../../shared/service/localServiceProtocol'

export class SocketFrames {
  readonly #socket: Socket
  readonly #messages = new Emitter<string>(() => this.close(new Error('SERVICE_FRAME_HANDLER_FAILED')))
  readonly #closed = new Emitter<Error>(() => {})
  readonly onFrame = this.#messages.event
  readonly onDidClose = this.#closed.event
  #buffer = Buffer.alloc(0)
  #ended = false
  #paused = false
  #queuedBytes = 0
  readonly #queued: string[] = []

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
    if (frame.includes('\n') || bytes > SERVICE_FRAME_BYTES || this.#socket.writableLength + bytes > SERVICE_CONNECTION_BYTES) {
      this.close(new Error('SERVICE_FRAME_LIMIT'))
      return false
    }
    this.#socket.write(`${frame}\n`)
    return true
  }

  pause(): void {
    this.#paused = true
  }

  resume(): void {
    this.#paused = false
    while (!this.#ended && !this.#paused && this.#queued.length) {
      const frame = this.#queued.shift()!
      this.#queuedBytes -= Buffer.byteLength(frame)
      this.#messages.fire(frame)
    }
  }

  transport(): RuntimeMessageTransport {
    return {
      postMessage: (message) => {
        if (!this.send(JSON.stringify(message)))
          throw new Error('SERVICE_CONNECTION_CLOSED')
      },
      subscribe: (listener) => {
        const subscription = this.onFrame(frame => listener(JSON.parse(frame)))
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
    this.#queued.length = 0
    this.#queuedBytes = 0
    this.#socket.destroy()
    this.#closed.fire(reason)
    this.#closed.dispose()
    this.#messages.dispose()
  }

  #receive(chunk: Buffer): void {
    if (this.#ended)
      return
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (!this.#ended) {
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
        if (this.#paused) {
          this.#queuedBytes += bytes.length
          if (this.#queuedBytes > SERVICE_CONNECTION_BYTES)
            throw new Error('SERVICE_FRAME_LIMIT')
          this.#queued.push(frame)
        }
        else { this.#messages.fire(frame) }
      }
      catch {
        this.close(new Error('SERVICE_FRAME_INVALID'))
      }
    }
  }
}
