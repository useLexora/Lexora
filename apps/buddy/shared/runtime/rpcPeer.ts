import type { RuntimeWireMessage } from './runtimeProtocol'

export interface RuntimeRpcPeerContract {
  notify: (method: string, params: unknown) => void
  onNotification: (listener: (method: string, params: unknown) => void) => () => void
  onRequest: (method: string, handler: RuntimeRequestHandler) => () => void
  request: (method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal, requestId?: string) => Promise<unknown>
  close: (reason: Error) => void
}

export interface RuntimeMessageTransport {
  postMessage: (message: RuntimeWireMessage) => void
  subscribe: (listener: (message: unknown) => void) => () => void
}

export interface RuntimeRpcPeerOptions {
  transport: RuntimeMessageTransport
  defaultTimeoutMs?: number
  onFatalError?: (error: Error) => void
}

export type RuntimeRequestHandler = (params: unknown, signal?: AbortSignal, requestId?: string) => Promise<unknown> | unknown
