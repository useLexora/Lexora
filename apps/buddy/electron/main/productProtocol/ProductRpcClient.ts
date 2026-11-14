import type { z } from 'zod'
import type { ProductError } from '../../../shared/productProtocol/errors'
import type { ProductIdentity } from '../../../shared/productProtocol/identity'
import { randomUUID } from 'node:crypto'
import { z as schema } from 'zod'
import { productErrorSchema } from '../../../shared/productProtocol/errors'
import { productIdentitySchema, productInitializeResultSchema, productInitializeSchema } from '../../../shared/productProtocol/identity'
import { encodeProductFrame, PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { getProductMethod } from '../../../shared/productProtocol/methods'
import { productAckSchema, productSnapshotPageSchema, productSubscribeSchema, productUnsubscribeSchema } from '../../../shared/productProtocol/sync'

export interface ProductClientTransport {
  send: (frame: string) => void | Promise<void>
  subscribe: (listener: (frame: string) => void) => () => void
  close: () => void
}
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}
const replySchema = schema.union([
  schema.object({ jsonrpc: schema.literal('2.0'), id: schema.string(), result: schema.unknown() }).strict(),
  schema.object({ jsonrpc: schema.literal('2.0'), id: schema.string().nullable(), error: productErrorSchema }).strict(),
  schema.object({ jsonrpc: schema.literal('2.0'), method: schema.enum(['sync.delta', 'sync.resyncRequired']), params: schema.unknown() }).strict(),
])

export class ProductRpcClient {
  readonly #transport: ProductClientTransport
  readonly #pending = new Map<string, PendingRequest>()
  readonly #listeners = new Set<(notification: { method: string, params: unknown }) => void>()
  readonly #unsubscribe: () => void
  readonly #timeoutMs: number
  #identity: ProductIdentity | null = null
  #initializing: Promise<z.infer<typeof productInitializeResultSchema>> | null = null
  #closed = false

  constructor(transport: ProductClientTransport, timeoutMs = 30_000) {
    this.#transport = transport
    this.#timeoutMs = timeoutMs
    this.#unsubscribe = transport.subscribe(frame => this.#receive(frame))
  }

  get identity(): ProductIdentity {
    if (!this.#identity)
      throw new Error('PRODUCT_NOT_INITIALIZED')
    return this.#identity
  }

  initialize(input: z.infer<typeof productInitializeSchema>): Promise<z.infer<typeof productInitializeResultSchema>> {
    if (!this.#initializing) {
      const parsed = productInitializeSchema.parse(input)
      this.#initializing = this.#request('initialize', parsed).then((raw) => {
        const result = productInitializeResultSchema.parse(raw)
        this.#identity = Object.freeze(productIdentitySchema.parse(Object.fromEntries(Object.keys(productIdentitySchema.shape).map(key => [key, result[key as keyof typeof result]]))))
        return result
      }).catch((error) => {
        this.close()
        throw error
      })
    }
    return this.#initializing
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.#identity)
      throw new Error('PRODUCT_NOT_INITIALIZED')
    const contract = getProductMethod(method)
    if (contract)
      return contract.output.parse(await this.#request(method, contract.input.parse(params)))
    const sync = method === 'sync.subscribe' ? productSubscribeSchema : method === 'sync.snapshotPage' ? productSnapshotPageSchema : method === 'sync.ack' ? productAckSchema : method === 'sync.unsubscribe' ? productUnsubscribeSchema : null
    if (!sync)
      throw new Error('PRODUCT_METHOD_NOT_AVAILABLE')
    return this.#request(method, sync.parse(params))
  }

  onNotification(listener: (notification: { method: string, params: unknown }) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    if (this.#closed)
      return
    this.#closed = true
    this.#unsubscribe()
    this.#transport.close()
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('PRODUCT_CONNECTION_CLOSED'))
    }
    this.#pending.clear()
    this.#listeners.clear()
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error('PRODUCT_CONNECTION_CLOSED'))
    if (this.#pending.size >= PRODUCT_LIMITS.inFlightRequests)
      return Promise.reject(new Error('PRODUCT_REQUEST_LIMIT'))
    const id = randomUUID()
    const frame = encodeProductFrame({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('PRODUCT_RESPONSE_UNKNOWN'))
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        Promise.resolve(this.#transport.send(frame)).catch(() => this.close())
      }
      catch { this.close() }
    })
  }

  #receive(frame: string): void {
    if (this.#closed)
      return
    try {
      if (frame.length > PRODUCT_LIMITS.frameBytes || productByteLength(frame) > PRODUCT_LIMITS.frameBytes)
        throw new Error('PRODUCT_FRAME_LIMIT')
      const reply = replySchema.parse(JSON.parse(frame))
      if ('method' in reply) {
        if (!this.#identity)
          throw new Error('PRODUCT_NOT_INITIALIZED')
        for (const listener of this.#listeners) {
          try {
            listener({ method: reply.method, params: reply.params })
          }
          catch {}
        }
        return
      }
      if (reply.id === null)
        throw new Error('PRODUCT_UNCORRELATED_ERROR')
      const request = this.#pending.get(reply.id)
      if (!request)
        return
      this.#pending.delete(reply.id)
      clearTimeout(request.timer)
      if ('error' in reply)
        request.reject(new ProductResponseError(reply.error))
      else
        request.resolve(reply.result)
    }
    catch { this.close() }
  }
}

export class ProductResponseError extends Error {
  readonly code: ProductError['code']
  readonly acceptance: ProductError['acceptance']
  readonly recovery: ProductError['recovery']

  constructor(error: ProductError) {
    super(error.message)
    this.code = error.code
    this.acceptance = error.acceptance
    this.recovery = error.recovery
  }
}
