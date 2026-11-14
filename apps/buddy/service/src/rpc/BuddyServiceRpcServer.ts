import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyServiceFailureCode } from '../../../shared/runtime/runtimeProtocol'
import { RuntimeRpcPeer } from '../../../platform/ipc/runtimeRpcPeer'
import { readDiagnosticErrorCode, safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { isRoutineRpc } from '../../../shared/diagnostics/rpcDiagnosticPolicy'
import { Emitter } from '../../../shared/events/Emitter'
import {
  BUDDY_SERVICE_PROTOCOL_VERSION,
  buddyServiceFailureNotificationSchema,
} from '../../../shared/runtime/runtimeProtocol'
import { diagnosticContext } from '../diagnostics/diagnosticContext'

import { registerServiceManagementRpc, SERVICE_NAME } from './registerServiceManagementRpc'
import { BuddyServiceError } from './runtimeRequest'

export interface BuddyServiceParentPort {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => unknown
  off: (event: 'message', listener: (event: { data: unknown }) => void) => unknown
}

export interface CreateBuddyServiceOptions {
  recordDiagnostic?: ApplicationDiagnosticReporter
  announceReady?: boolean
  port: BuddyServiceParentPort
  scheduleShutdown: () => void
  prepareIdleShutdown?: () => boolean
  onFatalError?: (error: Error) => void
}

export class BuddyServiceRpcServer implements RuntimeRpcPeerContract {
  readonly #record: ApplicationDiagnosticReporter
  readonly #peer: RuntimeRpcPeer
  readonly #closed = new Emitter<void>(() => this.#record({ event: 'observer.failed', component: 'runtime.rpc', level: 'warn' }))
  readonly onDidClose = this.#closed.event
  #isClosed = false
  #ready = false
  #stopping = false

  constructor(options: { port: BuddyServiceParentPort, onFatalError?: (error: Error) => void, recordDiagnostic?: ApplicationDiagnosticReporter }) {
    this.#record = safeDiagnosticReporter(options.recordDiagnostic)
    const { port } = options
    this.#peer = new RuntimeRpcPeer({
      onFatalError: (error) => {
        this.close(error)
        options.onFatalError?.(error)
      },
      transport: {
        postMessage: message => port.postMessage(message),
        subscribe(listener) {
          const handleMessage = (event: { data: unknown }) => listener(event.data)
          port.on('message', handleMessage)
          return () => port.off('message', handleMessage)
        },
      },
    })
  }

  notify(method: string, params: unknown): void {
    this.#peer.notify(method, params)
  }

  get ready(): boolean {
    return this.#ready
  }

  get closed(): boolean {
    return this.#isClosed
  }

  markReady(): boolean {
    if (this.#ready)
      return false
    this.#ready = true
    return true
  }

  stopAcceptingRequests(): void {
    this.#stopping = true
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    return this.#peer.onNotification(listener)
  }

  onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    return this.#peer.onRequest(method, async (params, signal, requestId) => {
      if (this.#stopping && method !== 'runtime.shutdown')
        throw new BuddyServiceError('RUNTIME_UNAVAILABLE')
      const operationId = requestId ?? crypto.randomUUID()
      const startedAt = performance.now()
      if (!isRoutineRpc(method))
        this.#record({ event: 'rpc.handler.started', level: 'debug', component: 'runtime.rpc', operationId, method })
      try {
        const result = await diagnosticContext.run({ operationId }, () => handler(params, signal, requestId))
        const durationMs = Math.round(performance.now() - startedAt)
        if (!isRoutineRpc(method) || durationMs >= 1000)
          this.#record({ event: 'rpc.handler.completed', level: isRoutineRpc(method) && durationMs >= 1000 ? 'warn' : 'debug', component: 'runtime.rpc', operationId, method, durationMs })
        return result
      }
      catch (error) {
        const errorType = error instanceof Error && /^[a-z]\w{0,95}$/i.test(error.name) ? error.name : 'UnknownError'
        this.#record({ event: 'rpc.handler.failed', level: 'error', component: 'runtime.rpc', operationId, durationMs: Math.round(performance.now() - startedAt), method, errorType, errorCode: readDiagnosticErrorCode(error) })
        throw error
      }
    })
  }

  request(method: string, params: unknown, timeoutMs?: number | null, signal?: AbortSignal, requestId?: string): Promise<unknown> {
    return this.#peer.request(method, params, timeoutMs, signal, requestId)
  }

  close(reason: Error): void {
    if (this.#isClosed)
      return
    this.#isClosed = true
    this.#peer.close(reason)
    this.#closed.fire()
    this.#closed.dispose()
  }
}

export function createBuddyService(options: CreateBuddyServiceOptions): BuddyServiceRpcServer {
  const server = new BuddyServiceRpcServer({
    recordDiagnostic: options.recordDiagnostic,
    port: options.port,
    onFatalError: options.onFatalError,
  })
  registerServiceManagementRpc(server, options.scheduleShutdown, options.prepareIdleShutdown)
  if (options.announceReady !== false)
    notifyBuddyServiceReady(server)
  return server
}

export function notifyBuddyServiceReady(
  server: Pick<BuddyServiceRpcServer, 'markReady' | 'notify'>,
): void {
  if (!server.markReady())
    return
  server.notify('runtime.ready', {
    name: SERVICE_NAME,
    protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
  })
}

export function notifyBuddyServiceFailure(
  server: Pick<BuddyServiceRpcServer, 'notify'>,
  code: BuddyServiceFailureCode,
): void {
  server.notify('runtime.failed', buddyServiceFailureNotificationSchema.parse({ code }))
}
