import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { ConversationModelSelection } from '../../storage/conversationRecord'

export interface BuddyExtensionRunContext {
  deferQueuedInputs?: boolean
  requestModel?: Readonly<ConversationModelSelection>
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
