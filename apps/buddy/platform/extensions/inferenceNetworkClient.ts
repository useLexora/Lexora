import type { InferenceNetworkOptions } from '../../shared/extensions/extensionInference'
import type { InferenceFrame } from './inferenceWire'
import { randomUUID } from 'node:crypto'
import { inferenceLimits } from '../../shared/extensions/extensionInference'

interface Pending {
  owner: string
  receive: (message: InferenceFrame, bytes: Uint8Array) => void
  close: () => void
}
export class InferenceNetworkClient {
  readonly #pending = new Map<string, Pending>()
  readonly #send: (message: InferenceFrame, bytes?: Uint8Array) => Promise<void>
  constructor(send: (message: InferenceFrame, bytes?: Uint8Array) => Promise<void>) { this.#send = send }

  receive(message: InferenceFrame, bytes: Uint8Array): void {
    const data = message.data
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.requestId !== 'string')
      throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
    const pending = this.#pending.get(data.requestId)
    if (pending && pending.owner === message.id)
      pending.receive(message, bytes)
  }

  post(owner: string, endpoint: string, body: Uint8Array, signal: AbortSignal, options: InferenceNetworkOptions = {}): Promise<Response> {
    signal.throwIfAborted()
    if (body.length > inferenceLimits.networkRequestBytes || this.#pending.size >= 4 || [...this.#pending.values()].some(item => item.owner === owner))
      throw new Error('EXTENSION_INFERENCE_NETWORK_LIMIT')
    const requestId = randomUUID()
    const send = (type: string) => this.#send({ type, id: owner, data: { requestId } })
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let pull: (() => void) | undefined
      let ended = false
      let offset = 0
      const cleanup = () => {
        ended = true
        this.#pending.delete(requestId)
        signal.removeEventListener('abort', cancel)
        pull?.()
      }
      function cancel() {
        if (ended)
          return
        const error = new Error('EXTENSION_INFERENCE_NETWORK_CANCELLED')
        controller?.error(error)
        reject(error)
        cleanup()
        void send('network.cancel').catch(() => {})
      }
      this.#pending.set(requestId, { owner, close: cancel, receive: (message, bytes) => {
        if (ended)
          return
        const data = message.data as Record<string, string | number | boolean>
        if (message.type === 'network.accepted') {
          if (data.offset !== offset || offset >= body.length) {
            cancel()
            return
          }
          const chunk = body.subarray(offset, offset + inferenceLimits.chunkBytes)
          const position = offset
          offset += chunk.length
          void this.#send({ type: 'network.input', id: owner, data: { requestId, offset: position } }, chunk).catch(cancel)
        }
        else if (message.type === 'network.response') {
          if (offset !== body.length || controller) {
            cancel()
            return
          }
          const headers = new Headers({ 'content-type': String(data.contentType) })
          if (typeof data.backendRequestId === 'string')
            headers.set('x-request-id', data.backendRequestId)
          if ([204, 205, 304].includes(Number(data.status))) {
            cleanup()
            void send('network.cancel').catch(() => {})
            resolve(new Response(null, { status: Number(data.status), headers }))
            return
          }
          const stream = new ReadableStream<Uint8Array>({
            start(value) { controller = value },
            pull() {
              return new Promise<void>((resolve, reject) => {
                pull = resolve
                void send('network.read').catch((error) => {
                  cancel()
                  reject(error)
                })
              })
            },
            cancel() {
              cleanup()
              void send('network.cancel').catch(() => {})
            },
          })
          resolve(new Response(stream, { status: Number(data.status), headers }))
        }
        else if (message.type === 'network.chunk') {
          if (data.done) {
            controller?.close()
            cleanup()
          }
          else {
            controller?.enqueue(bytes)
          }
          pull?.()
          pull = undefined
        }
        else if (message.type === 'network.error') {
          const error = new Error('EXTENSION_INFERENCE_NETWORK_FAILED')
          controller?.error(error)
          reject(error)
          cleanup()
          void send('network.cancel').catch(() => {})
        }
      } })
      signal.addEventListener('abort', cancel, { once: true })
      void this.#send({ type: 'network.request', id: owner, data: { requestId, endpoint, size: body.length, options } }).catch(cancel)
    })
  }

  close(owner: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.owner === owner)
        pending.close()
    }
  }
}
