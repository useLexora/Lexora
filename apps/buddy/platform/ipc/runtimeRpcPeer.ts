import type { RuntimeMessageTransport, RuntimeRequestHandler, RuntimeRpcPeerContract, RuntimeRpcPeerOptions } from '../../shared/runtime/rpcPeer'
import type { RuntimeWireMessage } from '../../shared/runtime/runtimeProtocol'
import { randomUUID } from 'node:crypto'

import { readLocalChatErrorCode } from '../../shared/runtime/localChatError'
import { runtimeWireMessageSchema } from '../../shared/runtime/runtimeProtocol'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

interface PendingRequest {
  dispose: () => void
  reject: (error: Error) => void
  resolve: (result: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

export class RuntimeProtocolError extends Error {
  readonly code = 'RUNTIME_PROTOCOL_ERROR'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeProtocolError'
  }
}

export class RuntimeRequestTimeoutError extends Error {
  readonly code = 'RUNTIME_REQUEST_TIMEOUT'

  constructor(method: string) {
    super(`Runtime request timed out: ${method}`)
    this.name = 'RuntimeRequestTimeoutError'
  }
}

export class RuntimeRemoteError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: { code: number, data?: unknown, message: string }) {
    super(error.message)
    this.name = 'RuntimeRemoteError'
    this.code = error.code
    this.data = error.data
  }
}

export class RuntimeRpcPeer implements RuntimeRpcPeerContract {
  readonly #transport: RuntimeMessageTransport
  readonly #defaultTimeoutMs: number
  readonly #onFatalError?: (error: Error) => void
  readonly #handlers = new Map<string, RuntimeRequestHandler>()
  readonly #notifications = new Set<(method: string, params: unknown) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #running = new Map<string, AbortController>()
  readonly #unsubscribe: () => void
  #closed = false

  constructor(options: RuntimeRpcPeerOptions) {
    this.#transport = options.transport
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#onFatalError = options.onFatalError
    this.#unsubscribe = this.#transport.subscribe(message => this.#handleMessage(message))
  }

  notify(method: string, params: unknown): void {
    this.#assertOpen()
    this.#transport.postMessage({ jsonrpc: '2.0', method, params })
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }

  onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    if (this.#handlers.has(method))
      throw new Error(`Runtime RPC handler is already registered: ${method}`)

    this.#handlers.set(method, handler)
    return () => this.#handlers.delete(method)
  }

  request(method: string, params: unknown, timeoutMs = this.#defaultTimeoutMs, signal?: AbortSignal, requestId?: string): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error('Runtime RPC peer is closed'))
    if (signal?.aborted)
      return Promise.reject(signal.reason)

    const id = requestId ?? randomUUID()
    if (this.#pending.has(id))
      return Promise.reject(new RuntimeProtocolError('Duplicate runtime request ID'))
    return new Promise((resolve, reject) => {
      const cancel = (reason: Error) => {
        const pending = this.#pending.get(id)
        if (!pending)
          return
        this.#pending.delete(id)
        pending.dispose()
        reject(reason)
        try {
          this.notify('$/cancelRequest', { id })
        }
        catch {
          this.#fail(new RuntimeProtocolError('Runtime cancellation delivery failed'))
        }
      }
      const aborted = () => cancel(signal?.reason ?? new DOMException('Request cancelled', 'AbortError'))
      const timeout = setTimeout(() => {
        cancel(new RuntimeRequestTimeoutError(method))
      }, timeoutMs)
      const dispose = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', aborted)
      }
      this.#pending.set(id, { reject, resolve, timeout, dispose })
      signal?.addEventListener('abort', aborted, { once: true })
      try {
        this.#transport.postMessage({ jsonrpc: '2.0', id, method, params })
      }
      catch (error) {
        this.#pending.delete(id)
        dispose()
        reject(error)
      }
    })
  }

  close(reason: Error): void {
    if (this.#closed)
      return

    this.#closed = true
    this.#unsubscribe()
    this.#handlers.clear()
    this.#notifications.clear()
    for (const pending of this.#pending.values()) {
      pending.dispose()
      pending.reject(reason)
    }
    this.#pending.clear()
    for (const running of this.#running.values())
      running.abort(reason)
    this.#running.clear()
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error('Runtime RPC peer is closed')
  }

  #handleMessage(message: unknown): void {
    if (this.#closed)
      return

    const parsed = runtimeWireMessageSchema.safeParse(message)
    if (!parsed.success) {
      this.#fail(new RuntimeProtocolError('Runtime emitted an invalid JSON-RPC message'))
      return
    }

    const wireMessage = parsed.data
    if ('method' in wireMessage) {
      if ('id' in wireMessage) {
        void this.#handleRequest(wireMessage.id, wireMessage.method, wireMessage.params).catch(() => this.#fail(new RuntimeProtocolError('Runtime response delivery failed')))
      }
      else if (wireMessage.method === '$/cancelRequest') {
        const params = wireMessage.params
        if (params && typeof params === 'object' && 'id' in params && typeof params.id === 'string')
          this.#running.get(params.id)?.abort(new DOMException('Request cancelled', 'AbortError'))
      }
      else {
        this.#emitNotification(wireMessage.method, wireMessage.params)
      }
      return
    }

    this.#handleResponse(wireMessage)
  }

  async #handleRequest(id: string, method: string, params: unknown): Promise<void> {
    if (this.#running.has(id)) {
      this.#fail(new RuntimeProtocolError('Duplicate runtime request ID'))
      return
    }
    const handler = this.#handlers.get(method)
    if (!handler) {
      this.#postFailure(id, -32_601, 'Lexora Buddy runtime method is unavailable', {
        code: 'BUDDY_RUNTIME_METHOD_NOT_FOUND',
        retryable: false,
      })
      return
    }

    const running = new AbortController()
    this.#running.set(id, running)
    try {
      const result = await handler(params, running.signal, id)
      if (!this.#closed && !running.signal.aborted)
        this.#transport.postMessage({ jsonrpc: '2.0', id, result })
    }
    catch (error) {
      if (!running.signal.aborted) {
        this.#postFailure(id, -32_000, 'Lexora Buddy runtime request failed', {
          code: readStableErrorCode(error),
          retryable: false,
        })
      }
    }
    finally {
      this.#running.delete(id)
    }
  }

  #postFailure(id: string, code: number, message: string, data: unknown): void {
    if (this.#closed)
      return

    this.#transport.postMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    })
  }

  #emitNotification(method: string, params: unknown): void {
    for (const listener of this.#notifications)
      listener(method, params)
  }

  #handleResponse(message: Exclude<RuntimeWireMessage, { method: string }>): void {
    const pending = this.#pending.get(message.id)
    if (!pending)
      return

    pending.dispose()
    this.#pending.delete(message.id)
    if ('result' in message) {
      pending.resolve(message.result)
      return
    }

    pending.reject(new RuntimeRemoteError(message.error))
  }

  #fail(error: Error): void {
    this.close(error)
    this.#onFatalError?.(error)
  }
}

function readStableErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(code)
    ? code
    : readLocalChatErrorCode(error) ?? 'BUDDY_RUNTIME_REQUEST_FAILED'
}
