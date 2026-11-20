import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRequestHandler } from '../../shared/runtime/rpcPeer'
import type { SocketFrames } from './SocketFrames'
import { diagnosticCodeSchema } from '../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../shared/events/Emitter'
import { DEFAULT_REQUEST_TIMEOUT_MS, RuntimeProtocolError, RuntimeRequestTimeoutError, RuntimeRpcPeer } from '../ipc/runtimeRpcPeer'

import { pagedServiceReads, readPartMethod, receiveServiceRead, releaseReadMethod, ServiceReadTransfer } from './ServiceReadTransfer'
import { ServiceFrameError } from './SocketFrames'

export class ServiceRpcChannel extends RuntimeRpcPeer {
  readonly #frames: SocketFrames
  readonly #closed = new Emitter<NonNullable<ApplicationDiagnostic['rpcDisconnect']>>(() => {})
  readonly onDidClose = this.#closed.event
  readonly #transfers = new ServiceReadTransfer()
  #ended = false

  constructor(frames: SocketFrames) {
    super({ transport: frames.transport(), onFatalError: error => frames.close(error) })
    this.#frames = frames
    super.onRequest(readPartMethod, params => this.#transfers.read(params))
    super.onRequest(releaseReadMethod, params => this.#transfers.release(params))
    frames.onDidClose(error => this.close(error))
  }

  get closed(): boolean { return this.#ended }

  override onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    if (!pagedServiceReads.has(method))
      return super.onRequest(method, handler)
    return super.onRequest(method, async (params, signal, id) => {
      const result = await handler(params, signal, id)
      signal?.throwIfAborted()
      return this.#transfers.encode(result)
    })
  }

  override async request(method: string, params: unknown, timeoutMs?: number | null, signal?: AbortSignal, requestId?: string): Promise<unknown> {
    if (!pagedServiceReads.has(method))
      return super.request(method, params, timeoutMs, signal, requestId)
    const deadline = timeoutMs === null ? null : Date.now() + (timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    const result = await super.request(method, params, timeoutMs, signal, requestId)
    return receiveServiceRead(result, (part) => {
      const remaining = deadline === null ? null : deadline - Date.now()
      if (remaining !== null && remaining <= 0)
        throw new RuntimeRequestTimeoutError(method)
      return super.request(readPartMethod, part, remaining, signal)
    }, (id) => { void super.request(releaseReadMethod, id, 5000).catch(() => {}) })
  }

  override close(reason: Error): void {
    if (this.#ended)
      return
    this.#ended = true
    const frameError = reason instanceof ServiceFrameError ? reason : undefined
    const disconnect = {
      ...this.#frames.activity,
      reason: frameError?.code ?? (reason instanceof RuntimeProtocolError ? reason.diagnosticCode : 'SERVICE_RPC_CLOSED'),
      frameBytes: frameError?.frameBytes,
      systemCode: diagnosticCodeSchema.safeParse(frameError?.systemCode).data,
    }
    this.#transfers.clear()
    super.close(reason)
    this.#frames.close(reason)
    this.#closed.fire(disconnect)
    this.#closed.dispose()
  }
}
