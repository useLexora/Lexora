import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../shared/runtime/rpcPeer'
import { Emitter } from '../../shared/events/Emitter'

export class HostUnavailableError extends Error {
  readonly code = 'PLATFORM_HOST_UNAVAILABLE'
  constructor() {
    super('PLATFORM_HOST_UNAVAILABLE')
    this.name = 'HostUnavailableError'
  }
}

export class HostConnection implements RuntimeRpcPeerContract {
  readonly #notifications = new Emitter<{ method: string, params: unknown }>(() => {})
  readonly #handlers = new Map<string, RuntimeRequestHandler>()
  #peer: RuntimeRpcPeerContract | null = null
  #instanceId: string | null = null
  #notificationBinding: (() => void) | undefined
  readonly #requestBindings = new Map<string, () => void>()
  #closed = false

  get instanceId(): string | null { return this.#instanceId }
  get available(): boolean { return this.#peer !== null && !this.#closed }

  attach(instanceId: string, peer: RuntimeRpcPeerContract): void {
    if (this.#closed || this.#peer)
      throw new Error('PLATFORM_HOST_ALREADY_ATTACHED')
    this.#peer = peer
    this.#instanceId = instanceId
    this.#notificationBinding = peer.onNotification((method, params) => {
      if (this.#peer === peer)
        this.#notifications.fire({ method, params })
    })
    for (const [method, handler] of this.#handlers)
      this.#requestBindings.set(method, peer.onRequest(method, handler))
  }

  detach(instanceId: string): void {
    if (this.#instanceId !== instanceId)
      return
    const peer = this.#peer
    this.#peer = null
    this.#instanceId = null
    this.#notificationBinding?.()
    this.#notificationBinding = undefined
    for (const stop of this.#requestBindings.values()) stop()
    this.#requestBindings.clear()
    peer?.close(new HostUnavailableError())
  }

  request(method: string, params: unknown, timeoutMs?: number | null, signal?: AbortSignal, requestId?: string): Promise<unknown> {
    const peer = this.#peer
    if (!peer || this.#closed)
      return Promise.reject(new HostUnavailableError())
    return peer.request(method, params, timeoutMs, signal, requestId)
  }

  notify(method: string, params: unknown): void {
    if (!this.#peer || this.#closed)
      throw new HostUnavailableError()
    this.#peer.notify(method, params)
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    return this.#notifications.event(event => listener(event.method, event.params)).dispose
  }

  onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    if (this.#handlers.has(method))
      throw new Error('PLATFORM_HOST_DUPLICATE_HANDLER')
    this.#handlers.set(method, handler)
    const dispose = this.#peer?.onRequest(method, handler)
    if (dispose)
      this.#requestBindings.set(method, dispose)
    return () => {
      if (this.#handlers.get(method) === handler)
        this.#handlers.delete(method)
      this.#requestBindings.get(method)?.()
      this.#requestBindings.delete(method)
    }
  }

  close(_reason: Error): void {
    this.#closed = true
    if (this.#instanceId)
      this.detach(this.#instanceId)
    this.#notifications.dispose()
    this.#handlers.clear()
  }
}
