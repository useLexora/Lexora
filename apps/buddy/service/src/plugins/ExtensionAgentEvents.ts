import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ExtensionActionTrigger, ExtensionAgentDescriptor } from '../../../shared/extensions/extensionAgent'
import type { ExtensionAgentMethod } from '../../../shared/extensions/extensionAgentCapabilities'

export interface ExtensionCapabilityProjection {
  readonly id: string
  readonly conversationId: string
  readonly revision: number
  readonly status: 'accepted' | 'unavailable'
  readonly descriptors: EventSnapshot<ExtensionAgentDescriptor[]>
}

interface InvocationIdentity {
  readonly invocationId: string
  readonly extensionId: string
  readonly conversationId: string
  readonly runId: string | null
  readonly actionId?: string
  readonly trigger?: ExtensionActionTrigger
}

export type ExtensionAgentFact
  = | { readonly kind: 'capabilities', readonly projection: ExtensionCapabilityProjection }
    | { readonly kind: 'capabilities-released', readonly projectionId: string, readonly conversationId: string }
    | (InvocationIdentity & { readonly kind: 'invocation', readonly stage: 'started' | 'returned' | 'settled', readonly outcome?: 'completed' | 'failed' | 'cancelled', readonly durationMs?: number })
    | (InvocationIdentity & { readonly kind: 'request', readonly requestId: string, readonly method: ExtensionAgentMethod, readonly stage: 'accepted' | 'finished', readonly handler?: 'completed' | 'failed', readonly response?: 'returned' | 'failed' | 'cancelled', readonly durationMs?: number })

export type ExtensionAgentChange = ExtensionAgentFact & { readonly revision: number }
