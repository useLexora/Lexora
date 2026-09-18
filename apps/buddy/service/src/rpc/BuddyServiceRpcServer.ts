import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyServiceFailureCode } from '../../../shared/runtime/runtimeProtocol'
import process from 'node:process'
import { RuntimeRpcPeer } from '../../../platform/ipc/runtimeRpcPeer'
import { readDiagnosticErrorCode, safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import {
  BUDDY_SERVICE_PROTOCOL_VERSION,
  buddyServiceFailureNotificationSchema,
} from '../../../shared/runtime/runtimeProtocol'

const SERVICE_NAME = 'lexora-buddy-service'

export interface BuddyServiceParentPort {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => unknown
  off: (event: 'message', listener: (event: { data: unknown }) => void) => unknown
}

export interface CreateBuddyServiceOptions {
  recordDiagnostic?: ApplicationDiagnosticReporter
  announceReady?: boolean
  port: BuddyServiceParentPort
  scheduleShutdown?: () => void
  onFatalError?: (error: Error) => void
}

export class BuddyServiceRpcServer implements RuntimeRpcPeerContract {
  readonly #record: ApplicationDiagnosticReporter
  readonly #peer: RuntimeRpcPeer
  #ready = false

  constructor(options: { port: BuddyServiceParentPort, onFatalError?: (error: Error) => void, recordDiagnostic?: ApplicationDiagnosticReporter }) {
    this.#record = safeDiagnosticReporter(options.recordDiagnostic)
    const { port } = options
    this.#peer = new RuntimeRpcPeer({
      onFatalError: options.onFatalError,
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

  markReady(): boolean {
    if (this.#ready)
      return false
    this.#ready = true
    return true
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    return this.#peer.onNotification(listener)
  }

  onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    return this.#peer.onRequest(method, async (params, signal) => {
      const operationId = crypto.randomUUID()
      const startedAt = performance.now()
      this.#record({ event: 'rpc.handler.started', level: 'debug', component: 'runtime.rpc', operationId, method })
      try {
        const result = await handler(params, signal)
        this.#record({ event: 'rpc.handler.completed', level: 'debug', component: 'runtime.rpc', operationId, method, durationMs: Math.round(performance.now() - startedAt) })
        return result
      }
      catch (error) {
        const errorType = error instanceof Error && /^[a-z]\w{0,95}$/i.test(error.name) ? error.name : 'UnknownError'
        this.#record({ event: 'rpc.handler.failed', level: 'error', component: 'runtime.rpc', operationId, durationMs: Math.round(performance.now() - startedAt), method, errorType, errorCode: readDiagnosticErrorCode(error) })
        throw error
      }
    })
  }

  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    return this.#peer.request(method, params, timeoutMs, signal)
  }

  close(reason: Error): void {
    this.#peer.close(reason)
  }
}

export function createBuddyService(options: CreateBuddyServiceOptions): BuddyServiceRpcServer {
  const server = new BuddyServiceRpcServer({
    recordDiagnostic: options.recordDiagnostic,
    port: options.port,
    onFatalError: options.onFatalError,
  })
  server.onRequest('runtime.status', () => ({
    name: SERVICE_NAME,
    protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
    ready: server.ready,
  }))
  server.onRequest('runtime.localState', () => ({
    status: server.ready ? 'ready' : 'starting',
  }))
  server.onRequest('runtime.shutdown', () => {
    setImmediate(options.scheduleShutdown ?? (() => process.exit(0)))
    return { accepted: true }
  })
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
