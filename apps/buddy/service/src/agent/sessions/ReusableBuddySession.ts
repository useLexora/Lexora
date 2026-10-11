import type { AgentSession, AgentSessionEvent, CompactionResult } from '@earendil-works/pi-coding-agent'
import type { BuddyServiceTier, BuddyThinkingLevel } from '../../../../shared/conversation/modelSelection'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { LocalCacheWarmingStatus } from '../../../../shared/runs/conversationStatusApi'
import type { SkillReference } from '../../../../shared/skills/skillApi'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyContextUsageBreakdown } from '../context/contextUsageBreakdown'

export interface BuddySessionModelSelection {
  provider: string
  model: string
  contextWindow: number | null
  maxTokens: number | null
  thinkingLevel?: BuddyThinkingLevel
  serviceTier?: BuddyServiceTier | null
}

export type BuddySessionShutdownReason = 'evict' | 'invalidate' | 'quit' | 'resource-change'

export interface BuddySessionEventSource {
  getToolLabel?: (name: string) => string | undefined
  getContextUsageBreakdown?: (
    totalTokens: number,
  ) => BuddyContextUsageBreakdown | null | Promise<BuddyContextUsageBreakdown | null>
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
}

export interface ReusableBuddySession extends BuddySessionEventSource {
  refreshModelSelection?: () => void
  updatePermissionSettings?: (settings: BuddyPermissionSettings) => void
  getModelUsage?: () => { providerId: string, modelId: string } | null
  getCacheWarmingStatus?: () => LocalCacheWarmingStatus
  getInputContext?: () => { messages: AgentSession['messages'] }
  steer?: (prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]) => boolean
  followUp?: (prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]) => boolean
  abort: () => Promise<void>
  abortCompaction: () => void
  activateTurn: (input: BuddySessionTurnContext) => Promise<() => void>
  canCompact: () => boolean
  compact: (customInstructions?: string) => Promise<CompactionResult>
  prompt: (text: string, options?: {
    expandPromptTemplates?: boolean
    inputReference?: BuddyInputReferenceV1
    source?: 'rpc'
  }) => Promise<void>
  shutdown: (reason: BuddySessionShutdownReason) => Promise<void>
  waitForIdle: () => Promise<void>
}

export interface BuddySessionTurnContext extends BuddySessionModelSelection {
  flushProjectedEvents: () => Promise<void>
  onToolExecutionAuthorized: (event: {
    arguments: unknown
    toolCallId: string
    toolName: string
  }) => Promise<void>
  onToolExecutionDenied: (event: {
    denialCode: string
    toolCallId: string
    toolName: string
  }) => Promise<void>
  runId: string
  signal: AbortSignal
}
