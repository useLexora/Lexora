import type { EventSnapshot } from '../../shared/events/eventTypes'
import type { ExtensionAgentDescriptor } from '../../shared/extensions/extensionAgent'

export interface ExtensionConfigurationApplication {
  readonly operationId: string
  readonly configurationRevision: string
  readonly generation: string | null
  readonly status: 'committed' | 'applied' | 'deferred' | 'invalidated' | 'apply-failed'
  readonly errorCode?: string
}

export type ExtensionServiceFact
  = | { readonly kind: 'package', readonly action: 'installed' | 'promoted' | 'uninstalled', readonly extensionId: string, readonly packageRevision?: string, readonly pendingRevision?: string }
    | { readonly kind: 'enabled', readonly extensionId: string, readonly enabled: boolean }
    | { readonly kind: 'resources-revoked', readonly extensionId: string }
    | { readonly kind: 'configuration', readonly extensionId: string, readonly application: ExtensionConfigurationApplication, readonly changedKeys: readonly string[], readonly errorCode?: string }
    | { readonly kind: 'host', readonly extensionId: string, readonly generation: string, readonly status: 'starting' | 'active' | 'failed' | 'stopping' | 'stopped' | 'stop-failed', readonly durationMs?: number, readonly errorCode?: string }
    | { readonly kind: 'view', readonly extensionId: string, readonly generation: string, readonly viewId: string, readonly status: 'opened' | 'ready' | 'failed' | 'closed' | 'cleanup-failed', readonly errorCode?: string }
    | { readonly kind: 'contributions', readonly initial: boolean, readonly descriptors: EventSnapshot<ExtensionAgentDescriptor[]> }
    | { readonly kind: 'installation-progress' }
    | { readonly kind: 'diagnostic', readonly extensionId: string, readonly event: string, readonly errorCode?: string, readonly durationMs?: number }

export type ExtensionServiceChange = ExtensionServiceFact & { readonly revision: number }
export interface ExtensionServiceSnapshot {
  readonly revision: number
  readonly extensions: readonly {
    readonly id: string
    readonly enabled: boolean
    readonly packageRevision: string
    readonly pendingRevision: string | null
    readonly generation: string | null
    readonly active: boolean
    readonly errorCode: string | null
    readonly configuration: ExtensionConfigurationApplication | null
  }[]
  readonly contributions: EventSnapshot<ExtensionAgentDescriptor[]>
  readonly views: readonly { readonly viewId: string, readonly extensionId: string, readonly generation: string, readonly ready: boolean, readonly errorCode: string | null }[]
}
