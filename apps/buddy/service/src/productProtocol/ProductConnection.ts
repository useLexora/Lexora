import type { z } from 'zod'
import type { TrustedProductContext } from '../../../shared/productProtocol/identity'
import type { ProductMethod } from '../../../shared/productProtocol/methods'
import type { ProductSyncPublisher } from './ProductSyncPublisher'
import { z as schema } from 'zod'
import { ProductProtocolError, projectProductError } from '../../../shared/productProtocol/errors'
import { PRODUCT_PROTOCOL_VERSION, productIdentitySchema, productInitializeResultSchema, productInitializeSchema } from '../../../shared/productProtocol/identity'
import { encodeProductFrame, PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { getProductMethod } from '../../../shared/productProtocol/methods'
import { productAckSchema, productSnapshotPageSchema, productSubscribeSchema, productUnsubscribeSchema } from '../../../shared/productProtocol/sync'

const requestSchema = schema.object({ jsonrpc: schema.literal('2.0'), id: schema.string().min(1).max(256), method: schema.string().min(1).max(256), params: schema.unknown() }).strict()
export type ProductClientCapabilities = Pick<z.infer<typeof productInitializeSchema>, 'supportedContentKinds' | 'supportedReviewKinds'>
export interface ProductRequestHandler {
  handle: (input: unknown, context: Readonly<TrustedProductContext>, client: ProductClientCapabilities) => unknown | Promise<unknown>
}
export interface ProductConnectionOptions {
  context: TrustedProductContext
  assertCurrent: () => void
  phase: () => 'starting' | 'recovering' | 'ready' | 'stopping'
  handlers: Partial<Record<ProductMethod, ProductRequestHandler>>
  sync?: ProductSyncPublisher
  authorizeTopic?: (topic: string, context: Readonly<TrustedProductContext>) => void
  send: (frame: string) => boolean
  close: () => void
}

export class ProductConnection {
  readonly #options: ProductConnectionOptions
  readonly #context: Readonly<TrustedProductContext>
  readonly #pending = new Set<string>()
  readonly #disconnectSync?: () => void
  #pendingBytes = 0
  #client: ProductClientCapabilities | null = null
  #closed = false

  constructor(options: ProductConnectionOptions) {
    this.#options = options
    this.#context = Object.freeze({ ...options.context })
    productIdentitySchema.parse(Object.fromEntries(Object.keys(productIdentitySchema.shape).map(key => [key, options.context[key as keyof TrustedProductContext]])))
    this.#disconnectSync = options.sync?.connect(this.#context.connectionId, { send: frame => this.#send(frame), close: () => this.close() })
  }

  async receive(raw: string): Promise<void> {
    if (this.#closed)
      return
    let id: string | null = null
    let dispatched = false
    let completed = false
    let tracked = false
    let bytes = 0
    try {
      if (raw.length > PRODUCT_LIMITS.frameBytes || productByteLength(raw) > PRODUCT_LIMITS.frameBytes)
        throw new ProductProtocolError('FRAME_TOO_LARGE')
      bytes = productByteLength(raw)
      if (this.#pendingBytes + bytes > PRODUCT_LIMITS.connectionBytes)
        throw new ProductProtocolError('FRAME_TOO_LARGE')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      }
      catch { throw new ProductProtocolError('INVALID_REQUEST') }
      const request = requestSchema.safeParse(parsed)
      if (!request.success)
        throw new ProductProtocolError('INVALID_REQUEST')
      id = request.data.id
      if (this.#pending.has(id))
        throw new ProductProtocolError('INVALID_REQUEST', 'unknown')
      if (this.#pending.size >= PRODUCT_LIMITS.inFlightRequests)
        throw new ProductProtocolError('INVALID_REQUEST')
      this.#pending.add(id)
      tracked = true
      this.#pendingBytes += bytes
      this.#options.assertCurrent()
      const { method, params } = request.data
      if (method === 'initialize') {
        if (this.#client)
          throw new ProductProtocolError('ALREADY_INITIALIZED')
        const initialized = productInitializeSchema.safeParse(params)
        if (!initialized.success)
          throw new ProductProtocolError('INVALID_PARAMS')
        if (initialized.data.protocol.major !== PRODUCT_PROTOCOL_VERSION.major || initialized.data.protocol.minMinor > PRODUCT_PROTOCOL_VERSION.minor || initialized.data.protocol.maxMinor < PRODUCT_PROTOCOL_VERSION.minor)
          throw new ProductProtocolError('PROTOCOL_INCOMPATIBLE')
        this.#client = Object.freeze({ supportedContentKinds: [...initialized.data.supportedContentKinds], supportedReviewKinds: [...initialized.data.supportedReviewKinds] })
        const identity = productIdentitySchema.parse(Object.fromEntries(Object.keys(productIdentitySchema.shape).map(key => [key, this.#context[key as keyof TrustedProductContext]])))
        const capabilities = [...Object.keys(this.#options.handlers), ...(this.#options.sync ? ['sync.subscribe', 'sync.snapshotPage', 'sync.ack', 'sync.unsubscribe'] : [])].filter(method => this.#context.role === 'owner' || getProductMethod(method)?.role === 'reader' || method.startsWith('sync.'))
        this.#reply(id, productInitializeResultSchema.parse({ ...identity, protocol: PRODUCT_PROTOCOL_VERSION, serverTime: new Date().toISOString(), phase: this.#options.phase(), capabilities, limits: PRODUCT_LIMITS }))
        return
      }
      if (!this.#client)
        throw new ProductProtocolError('NOT_INITIALIZED')
      if (method === 'sync.subscribe' && this.#options.sync) {
        const request = productSubscribeSchema.safeParse(params)
        if (!request.success)
          throw new ProductProtocolError('INVALID_PARAMS')
        if (!this.#options.authorizeTopic)
          throw new ProductProtocolError('NOT_AUTHORIZED')
        this.#options.authorizeTopic(request.data.topic, this.#context)
        const subscription = this.#options.sync.subscribe(this.#context.connectionId, request.data)
        if (this.#reply(id, subscription.snapshot))
          subscription.activate()
        return
      }
      if (method === 'sync.snapshotPage' && this.#options.sync) {
        const request = productSnapshotPageSchema.safeParse(params)
        if (!request.success)
          throw new ProductProtocolError('INVALID_PARAMS')
        const page = this.#options.sync.snapshotPage(this.#context.connectionId, request.data)
        if (this.#reply(id, page.snapshot))
          page.activate()
        return
      }
      if (method === 'sync.ack' && this.#options.sync) {
        const request = productAckSchema.safeParse(params)
        if (!request.success)
          throw new ProductProtocolError('INVALID_PARAMS')
        this.#options.sync.ack(this.#context.connectionId, request.data)
        this.#reply(id, { acknowledged: true })
        return
      }
      if (method === 'sync.unsubscribe' && this.#options.sync) {
        const request = productUnsubscribeSchema.safeParse(params)
        if (!request.success)
          throw new ProductProtocolError('INVALID_PARAMS')
        this.#options.sync.unsubscribe(this.#context.connectionId, request.data.subscriptionId)
        this.#reply(id, { unsubscribed: true })
        return
      }
      const contract = getProductMethod(method)
      const handler = this.#options.handlers[method as ProductMethod]
      if (!contract || !handler)
        throw new ProductProtocolError('METHOD_NOT_AVAILABLE')
      if (contract.role === 'owner' && this.#context.role !== 'owner')
        throw new ProductProtocolError('NOT_AUTHORIZED')
      if (contract.ready && this.#options.phase() !== 'ready')
        throw new ProductProtocolError('SERVICE_NOT_READY')
      const input = contract.input.safeParse(params)
      if (!input.success)
        throw new ProductProtocolError('INVALID_PARAMS')
      dispatched = contract.command || method === 'commands.get'
      const output = await handler.handle(input.data, this.#context, this.#client)
      completed = true
      this.#options.assertCurrent()
      this.#reply(id, contract.output.parse(output))
    }
    catch (error) {
      this.#send(encodeProductFrame({ jsonrpc: '2.0', id, error: projectProductError(error, dispatched, completed && dispatched) }))
    }
    finally {
      if (tracked && id) {
        this.#pendingBytes -= bytes
        this.#pending.delete(id)
      }
    }
  }

  close(): void {
    if (this.#closed)
      return
    this.#closed = true
    this.#disconnectSync?.()
    this.#options.close()
  }

  #reply(id: string, result: unknown): boolean {
    return this.#send(encodeProductFrame({ jsonrpc: '2.0', id, result }))
  }

  #send(frame: string): boolean {
    if (this.#closed)
      return false
    try {
      if (this.#options.send(frame))
        return true
    }
    catch {}
    this.close()
    return false
  }
}
