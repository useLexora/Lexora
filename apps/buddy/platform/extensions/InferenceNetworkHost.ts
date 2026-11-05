import type { Writable } from 'node:stream'
import type { InferenceNetworkOptions } from '../../shared/extensions/extensionInference'
import type { InferenceFrame } from './inferenceWire'
import { z } from 'zod'
import { inferenceIdSchema, inferenceLimits, inferenceNetworkOptionsSchema } from '../../shared/extensions/extensionInference'
import { writeInferenceFrame } from './inferenceWire'

export type InferenceNetworkRequest = (name: string, body: Uint8Array, signal: AbortSignal, options?: InferenceNetworkOptions) => Promise<Response>
interface Transfer {
  owner: string
  endpoint: string
  options: InferenceNetworkOptions
  upload?: Uint8Array
  offset: number
  abort: AbortController
  signal: AbortSignal
  operation: Promise<void>
  closing?: Promise<void>
  dispose: () => void
  reader?: ReadableStreamDefaultReader<Uint8Array>
  remainder: Uint8Array
  size: number
  reading: boolean
}
const identitySchema = z.object({ requestId: z.uuid() }).strict()
const requestSchema = identitySchema.extend({ endpoint: inferenceIdSchema, size: z.number().int().min(0).max(inferenceLimits.networkRequestBytes), options: inferenceNetworkOptionsSchema.default({}) }).strict()
const inputSchema = identitySchema.extend({ offset: z.number().int().min(0).max(inferenceLimits.networkRequestBytes) }).strict()
export class InferenceNetworkHost {
  readonly #transfers = new Map<string, Transfer>()
  readonly write: Writable
  readonly request: InferenceNetworkRequest | undefined
  constructor(write: Writable, request?: InferenceNetworkRequest) {
    this.write = write
    this.request = request
  }

  #send(owner: string, requestId: string, type: string, data: Record<string, string | number | boolean> = {}, bytes?: Uint8Array) {
    return writeInferenceFrame(this.write, { type, id: owner, data: { requestId, ...data } }, bytes)
  }

  receive(owner: string, message: InferenceFrame, bytes: Uint8Array, signal: AbortSignal): void {
    if (message.type === 'network.request') {
      const { requestId, endpoint, size, options } = requestSchema.parse(message.data)
      if (bytes.length || this.#transfers.size >= 4 || this.#transfers.has(requestId) || [...this.#transfers.values()].some(item => item.owner === owner))
        throw new Error('EXTENSION_INFERENCE_NETWORK_LIMIT')
      if (signal.aborted) {
        void this.#send(owner, requestId, 'network.error').catch(() => {})
        return
      }
      const abort = new AbortController()
      const lifetime = AbortSignal.any([abort.signal, signal, AbortSignal.timeout(inferenceLimits.networkTimeoutMs)])
      const transfer: Transfer = { owner, endpoint, options, upload: new Uint8Array(size), offset: 0, abort, signal: lifetime, operation: Promise.resolve(), dispose: () => {}, remainder: new Uint8Array(), size: 0, reading: false }
      const close = () => {
        void this.#fail(requestId, transfer)
      }
      transfer.dispose = () => lifetime.removeEventListener('abort', close)
      this.#transfers.set(requestId, transfer)
      lifetime.addEventListener('abort', close, { once: true })
      if (size)
        void this.#send(owner, requestId, 'network.accepted', { offset: 0 }).catch(close)
      else
        this.#submit(requestId, transfer)
      return
    }
    const { requestId } = (message.type === 'network.input' ? inputSchema : identitySchema).parse(message.data)
    const transfer = this.#transfers.get(requestId)
    if (!transfer && ['network.cancel', 'network.input', 'network.read'].includes(message.type))
      return
    if (!transfer || transfer.owner !== owner)
      throw new Error('EXTENSION_INFERENCE_NETWORK_UNAVAILABLE')
    if (message.type === 'network.cancel') {
      void this.#close(requestId, transfer)
      return
    }
    if (transfer.closing)
      return
    if (message.type === 'network.input') {
      const { offset } = inputSchema.parse(message.data)
      if (!transfer.upload || offset !== transfer.offset || !bytes.length || bytes.length > inferenceLimits.chunkBytes || offset + bytes.length > transfer.upload.length)
        throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
      transfer.upload.set(bytes, offset)
      transfer.offset += bytes.length
      if (transfer.offset === transfer.upload.length)
        this.#submit(requestId, transfer)
      else
        void this.#send(owner, requestId, 'network.accepted', { offset: transfer.offset }).catch(() => this.#close(requestId, transfer))
      return
    }
    if (message.type !== 'network.read' || transfer.upload || transfer.reading || bytes.length)
      throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
    transfer.reading = true
    transfer.operation = (async () => {
      try {
        transfer.signal.throwIfAborted()
        while (!transfer.remainder.length) {
          const next = await transfer.reader?.read()
          if (!next || next.done)
            break
          transfer.signal.throwIfAborted()
          transfer.remainder = next.value
          transfer.size += transfer.remainder.length
          if (transfer.size > inferenceLimits.networkResponseBytes)
            throw new Error('EXTENSION_INFERENCE_NETWORK_LIMIT')
        }
        const chunk = transfer.remainder.subarray(0, inferenceLimits.chunkBytes)
        transfer.remainder = transfer.remainder.subarray(chunk.length)
        if (!chunk.length) {
          transfer.reader?.releaseLock()
          transfer.reader = undefined
          transfer.dispose()
          this.#transfers.delete(requestId)
        }
        transfer.reading = false
        await this.#send(owner, requestId, 'network.chunk', { done: !chunk.length }, chunk)
      }
      catch { await this.#fail(requestId, transfer) }
    })()
  }

  #submit(requestId: string, transfer: Transfer) {
    const body = transfer.upload!
    transfer.upload = undefined
    transfer.reading = true
    transfer.operation = (async () => {
      try {
        transfer.signal.throwIfAborted()
        if (!this.request)
          throw new Error('EXTENSION_INFERENCE_NETWORK_DENIED')
        const response = await this.request(transfer.endpoint, body, transfer.signal, transfer.options)
        transfer.reader = response.body?.getReader()
        transfer.signal.throwIfAborted()
        if (response.status >= 300 && response.status < 400)
          throw new Error('EXTENSION_INFERENCE_NETWORK_REDIRECT')
        const backendRequestId = response.headers.get('x-request-id')
        transfer.reading = false
        await this.#send(transfer.owner, requestId, 'network.response', {
          status: response.status,
          contentType: (response.headers.get('content-type') ?? 'application/octet-stream').slice(0, 1024),
          ...(backendRequestId && /^[\x21-\x7E]{1,256}$/.test(backendRequestId) ? { backendRequestId } : {}),
        })
      }
      catch { await this.#fail(requestId, transfer) }
    })()
  }

  async #fail(requestId: string, transfer: Transfer) {
    await this.#send(transfer.owner, requestId, 'network.error').catch(() => {})
    void this.#close(requestId, transfer)
  }

  #close(id: string, transfer: Transfer): Promise<void> {
    return transfer.closing ??= Promise.resolve().then(async () => {
      transfer.dispose()
      transfer.abort.abort()
      await transfer.operation
      await transfer.reader?.cancel().catch(() => {})
      transfer.reader?.releaseLock()
      transfer.upload = undefined
      transfer.remainder = new Uint8Array()
      this.#transfers.delete(id)
    })
  }

  async close(owner?: string): Promise<void> {
    await Promise.all([...this.#transfers].filter(([, transfer]) => owner === undefined || transfer.owner === owner).map(([id, transfer]) => this.#close(id, transfer)))
  }
}
