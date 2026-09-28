import type { BrowserAction } from '../../../shared/browser'
import type { DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BrowserSessionTeardownReason } from './BrowserSessionRegistry'

export type BrowserHostFact
  = | { readonly kind: 'session', readonly state: EventSnapshot<DesktopBrowserState>, readonly status: 'opened' }
    | { readonly kind: 'session', readonly state: EventSnapshot<DesktopBrowserState>, readonly status: 'closed', readonly reason: BrowserSessionTeardownReason }
    | { readonly kind: 'state', readonly state: EventSnapshot<DesktopBrowserState> }
    | { readonly kind: 'guest', readonly sessionId: string, readonly pageId: string, readonly status: 'attached' | 'detached' | 'crashed' }
    | { readonly kind: 'control', readonly sessionId: string, readonly pageId: string, readonly controller: 'agent' | 'human', readonly controlEpoch: number }
    | { readonly kind: 'action', readonly operationId: string, readonly sessionId: string, readonly pageId: string, readonly action: BrowserAction['kind'], readonly phase: 'dispatched' | 'confirmed' | 'verified' | 'failed', readonly effect: 'not-dispatched' | 'unknown' | 'confirmed', readonly errorCode?: string }

export type BrowserHostChange = BrowserHostFact & { readonly revision: number }
