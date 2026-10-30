import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { ImagePreferencesSnapshot } from '../../../../shared/images/imagePreferences'
import type { ToolExecutionPhaseChange } from '../../../../shared/runs/toolExecutionPhase'
import type { BuddyExecutionIdentity } from '../../buddies/BuddyExecutionDefinition'
import type { ConversationModelSelection } from '../../storage/conversationRecord'

export interface BuddyExtensionRunContext {
  actorIdentity?: BuddyExecutionIdentity
  imagePreferences?: ImagePreferencesSnapshot
  deferQueuedInputs?: boolean
  requestModel?: Readonly<ConversationModelSelection>
  flushProjectedEvents: () => Promise<void>
  onToolExecutionPhase?: (event: ToolExecutionPhaseChange) => void
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
