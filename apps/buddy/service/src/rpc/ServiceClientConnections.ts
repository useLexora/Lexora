import type { Event } from '../../../shared/events/Emitter'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from './runtimeRequest'

export type ServiceClientRole = 'product' | 'management'
export interface ServiceClientPeer extends Pick<RuntimeRpcPeerContract, 'notify' | 'onRequest' | 'close'> {
  readonly closed: boolean
  readonly onDidClose: Event<void>
}

interface Connection {
  role: ServiceClientRole
  peer: ServiceClientPeer
  stopRequests: () => void
  dispose: () => void
}

export class ServiceClientConnections {
  readonly #connections = new Set<Connection>()
  readonly #assertAvailable: () => void
  #accepting = true

  constructor(assertAvailable: () => void = () => {}) {
    this.#assertAvailable = assertAvailable
  }

  connect(role: ServiceClientRole, peer: ServiceClientPeer, register: (rpc: RuntimeRequestRegistrar, role: ServiceClientRole) => void): () => void {
    this.#assertAvailable()
    if (!this.#accepting || peer.closed)
      throw new Error('SERVICE_CONNECTION_UNAVAILABLE')
    const controller = new AbortController()
    const registrations = new Set<() => void>()
    let closed: ReturnType<ServiceClientPeer['onDidClose']> | undefined
    const connection: Connection = {
      role,
      peer,
      stopRequests() {
        controller.abort(new Error('SERVICE_CONNECTION_CLOSED'))
        for (const unregister of registrations) unregister()
        registrations.clear()
      },
      dispose: () => {
        connection.stopRequests()
        closed?.dispose()
        this.#connections.delete(connection)
      },
    }
    closed = peer.onDidClose(connection.dispose)
    this.#connections.add(connection)
    try {
      register({ onRequest: (method, handler) => {
        controller.signal.throwIfAborted()
        const unregister = peer.onRequest(method, async (params, signal, requestId) => {
          const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
          this.#assertAvailable()
          waiting.throwIfAborted()
          const result = await handler(params, waiting, requestId)
          this.#assertAvailable()
          waiting.throwIfAborted()
          return result
        })
        const dispose = () => {
          if (registrations.delete(dispose))
            unregister()
        }
        registrations.add(dispose)
        return dispose
      } }, role)
      return connection.dispose
    }
    catch (error) {
      connection.dispose()
      throw error
    }
  }

  notify(role: ServiceClientRole, method: string, params: unknown): void {
    for (const connection of this.#connections) {
      if (connection.role !== role)
        continue
      try {
        connection.peer.notify(method, params)
      }
      catch {
        connection.dispose()
        connection.peer.close(new Error('SERVICE_NOTIFICATION_FAILED'))
      }
    }
  }

  stopAccepting(): void {
    this.#accepting = false
    for (const connection of this.#connections) connection.stopRequests()
  }

  dispose(): void {
    this.stopAccepting()
    for (const connection of this.#connections) connection.dispose()
  }
}
