import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { RuntimeRpcPeer } from '../../../platform/ipc/runtimeRpcPeer'

export interface BuddyServiceMessageProcess {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (message: unknown) => void) => unknown
  off: (event: 'message', listener: (message: unknown) => void) => unknown
}

export interface BuddyServicePeerOptions {
  process: BuddyServiceMessageProcess
  defaultTimeoutMs?: number
  onFatalError?: (error: Error) => void
}

export class BuddyServicePeer implements RuntimeRpcPeerContract {
  readonly #peer: RuntimeRpcPeer

  constructor(options: BuddyServicePeerOptions) {
    const utilityProcess = options.process
    this.#peer = new RuntimeRpcPeer({
      defaultTimeoutMs: options.defaultTimeoutMs,
      onFatalError: options.onFatalError,
      transport: {
        postMessage: message => utilityProcess.postMessage(message),
        subscribe(listener) {
          const handleMessage = (message: unknown) => listener(message)
          utilityProcess.on('message', handleMessage)
          return () => utilityProcess.off('message', handleMessage)
        },
      },
    })
  }

  notify(method: string, params: unknown): void {
    this.#peer.notify(method, params)
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    return this.#peer.onNotification(listener)
  }

  onRequest(method: string, handler: RuntimeRequestHandler): () => void {
    return this.#peer.onRequest(method, handler)
  }

  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    return this.#peer.request(method, params, timeoutMs, signal)
  }

  close(reason: Error): void {
    this.#peer.close(reason)
  }
}
