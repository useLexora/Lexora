import type { ConnectorErrorCode, ConnectorRuntimeState } from '../../../../shared/connectors/connectorState'

export interface McpCatalogTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>> & { readonly type: 'object' }
  readonly outputSchema?: Readonly<Record<string, unknown>>
  readonly annotations?: {
    readonly title?: string
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly idempotentHint?: boolean
    readonly openWorldHint?: boolean
  }
}

export interface McpEventIdentity {
  readonly sourceId: string
  readonly revision: number
  readonly connectorId: string
  readonly generation: number
}

export type McpConnectionDetails = (
  | { readonly type: 'generation', readonly previousGeneration: number }
  | { readonly type: 'availability', readonly available: boolean }
  | { readonly type: 'state', readonly snapshot: Readonly<ConnectorRuntimeState> }
  | { readonly type: 'catalog', readonly catalogRevision: string, readonly previousRevision: string | null, readonly tools: readonly McpCatalogTool[] }
  | { readonly type: 'cleanup', readonly status: 'completed' | 'degraded' }
)

export type McpConnectorDetails = (
  | { readonly type: 'configuration', readonly kind: 'created' | 'updated' | 'removed', readonly enabled: boolean, readonly executionChanged: boolean }
  | { readonly type: 'credential', readonly status: 'written' | 'deleted' | 'restored' | 'restore-failed', readonly presence: 'present' | 'absent' | 'unknown' }
  | { readonly type: 'login', readonly operationId: string, readonly status: 'started' | 'succeeded' | 'failed' | 'cancelled', readonly errorCode?: ConnectorErrorCode }
)

export type McpConnectionEvent = McpEventIdentity & McpConnectionDetails
export type McpConnectorEvent = McpEventIdentity & McpConnectorDetails
