import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentSession, AgentSessionEvent, CompactionResult } from '@earendil-works/pi-coding-agent'
import type { BuddyServiceTier, BuddyThinkingLevel } from '../../../../shared/conversation/modelSelection'
import type { LocalCacheWarmingStatus } from '../../../../shared/runs/conversationStatusApi'
import type { SkillReference } from '../../../../shared/skills/skillApi'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyContextUsageBreakdown } from '../context/contextUsageBreakdown'

export type BuddySessionShutdownReason = 'evict' | 'invalidate' | 'quit' | 'resource-change'

export interface BuddySessionEventSource {
  getToolLabel?: (name: string) => string | undefined
  getContextUsageBreakdown?: (
    totalTokens: number,
  ) => BuddyContextUsageBreakdown | null | Promise<BuddyContextUsageBreakdown | null>
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
}

export interface ReusableBuddySession extends BuddySessionEventSource {
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
    images?: ImageContent[]
    inputReference?: BuddyInputReferenceV1
    source?: 'rpc'
  }) => Promise<void>
  shutdown: (reason: BuddySessionShutdownReason) => Promise<void>
  waitForIdle: () => Promise<void>
}

export interface BuddySessionTurnContext {
  contextWindow: number | null
  flushProjectedEvents: () => Promise<void>
  maxTokens: number | null
  model: string
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
  provider: string
  runId: string
  serviceTier?: BuddyServiceTier | null
  signal: AbortSignal
  thinkingLevel?: BuddyThinkingLevel
}
