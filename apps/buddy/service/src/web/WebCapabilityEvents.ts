import type { WebErrorCode, WebSearchProvider } from '../../../shared/network/webProtocol'

export interface WebOperationFact {
  readonly phase: 'started' | 'attempt-started' | 'attempt-finished' | 'render-fallback' | 'received' | 'cache-published' | 'cache-cleanup-failed' | 'settled'
  readonly provider?: WebSearchProvider | 'local'
  readonly mode?: 'http' | 'render' | 'remote'
  readonly attempt?: number
  readonly count?: number
  readonly durationMs?: number
  readonly errorCode?: WebErrorCode
  readonly outcome?: 'completed' | 'failed'
  readonly cancelled?: boolean
}

export type WebCapabilityChange = WebOperationFact & { readonly operationId: string, readonly revision: number, readonly kind: 'search' | 'fetch' }
export type WebOperationObserver = (fact: WebOperationFact) => void
