import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'

export interface BuddyExtensionRunContext {
  flushProjectedEvents: () => Promise<void>
  onToolExecutionAuthorized: (event: {
    arguments: unknown
    toolCallId: string
    toolName: string
  }) => Promise<void>
  onToolExecutionDenied?: (event: {
    denialCode: string
    toolCallId: string
    toolName: string
  }) => Promise<void>
  runId: string
  retryModelChanged?: boolean
  serviceTier?: BuddyServiceTier | null
  signal: AbortSignal
}

export interface BuddyExtensionRunContextStore {
  current: BuddyExtensionRunContext | null
}
