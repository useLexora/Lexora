import type { AgentChatContextMessage } from '@haohaoxue/lexora-contracts'
import type { AgentContextBudget } from './budget'
import { trimMessages } from '@langchain/core/messages'
import { toLangChainChatMessages } from '../messages/langchain'
import { defaultAgentTokenEstimator } from '../tokens/estimator'

export interface AgentHistoryDigest {
  schemaVersion: 1
  summary: string
  coveredMessageIds: string[]
  sourceHistoryVersion: number
  estimatedTokens: number
  createdAt: string
  updatedAt: string
}

export interface CompactAgentHistoryInput {
  sessionHistoryVersion: number
  triggerUserMessageId: string
  messages: AgentChatContextMessage[]
  budget: Pick<AgentContextBudget, 'availableInputTokens' | 'recentMessageBudgetTokens' | 'recentMessageTokens' | 'budgetUsedRatio' | 'compactionThreshold' | 'overflowTokens'>
  historyDigest?: AgentHistoryDigest | null
  now?: () => Date
}

export interface AgentHistoryCompactionDecision {
  shouldCompact: boolean
  reason: 'below-threshold' | 'threshold-exceeded' | 'overflow' | 'required-message-overflow'
}

export interface AgentHistoryCompactionResult {
  messages: AgentChatContextMessage[]
  historyDigest: AgentHistoryDigest | null
  compactedMessageIds: string[]
  decision: AgentHistoryCompactionDecision
}

const MAX_DETERMINISTIC_DIGEST_LENGTH = 4000

export function shouldCompactHistory(
  input: Pick<CompactAgentHistoryInput, 'budget' | 'messages' | 'triggerUserMessageId' | 'historyDigest'>,
): AgentHistoryCompactionDecision {
  const triggerMessage = input.messages.find(message => message.id === input.triggerUserMessageId)
  const triggerTokens = triggerMessage
    ? defaultAgentTokenEstimator.estimateMessageTokens(triggerMessage).estimatedTokens
    : 0

  if (triggerTokens > input.budget.recentMessageBudgetTokens) {
    return {
      shouldCompact: true,
      reason: 'required-message-overflow',
    }
  }

  if (input.budget.overflowTokens > 0) {
    return {
      shouldCompact: true,
      reason: 'overflow',
    }
  }

  if (input.budget.budgetUsedRatio >= input.budget.compactionThreshold) {
    return {
      shouldCompact: true,
      reason: 'threshold-exceeded',
    }
  }

  return {
    shouldCompact: false,
    reason: 'below-threshold',
  }
}

export async function compactAgentHistory(input: CompactAgentHistoryInput): Promise<AgentHistoryCompactionResult> {
  const decision = shouldCompactHistory(input)
  if (!decision.shouldCompact) {
    return {
      messages: input.messages,
      historyDigest: input.historyDigest ?? null,
      compactedMessageIds: [],
      decision,
    }
  }

  const keptMessages = await selectRecentMessages({
    messages: input.messages,
    triggerUserMessageId: input.triggerUserMessageId,
    recentMessageBudgetTokens: input.budget.recentMessageBudgetTokens,
  })
  const keptMessageIds = new Set(keptMessages.map(message => message.id))
  const compactedMessages = input.messages.filter(message => !keptMessageIds.has(message.id))
  const historyDigest = compactedMessages.length > 0
    ? mergeAgentHistoryDigest({
        previousDigest: input.historyDigest ?? null,
        compactedMessages,
        sessionHistoryVersion: input.sessionHistoryVersion,
        now: input.now ?? (() => new Date()),
      })
    : input.historyDigest ?? null

  return {
    messages: keptMessages,
    historyDigest,
    compactedMessageIds: compactedMessages.map(message => message.id),
    decision,
  }
}

export function mergeAgentHistoryDigest(input: {
  previousDigest: AgentHistoryDigest | null
  compactedMessages: AgentChatContextMessage[]
  sessionHistoryVersion: number
  now: () => Date
}): AgentHistoryDigest | null {
  const now = input.now().toISOString()
  const additions = input.compactedMessages
    .filter(message => message.content.trim())
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim()}`)
    .join('\n')
  if (!additions) {
    return input.previousDigest
  }

  const summary = trimDigestSummary([input.previousDigest?.summary, additions].filter(Boolean).join('\n'))
  const coveredMessageIds = unique([
    ...(input.previousDigest?.coveredMessageIds ?? []),
    ...input.compactedMessages.map(message => message.id),
  ])

  return {
    schemaVersion: 1,
    summary,
    coveredMessageIds,
    sourceHistoryVersion: input.sessionHistoryVersion,
    estimatedTokens: defaultAgentTokenEstimator.estimateTextTokens(summary).estimatedTokens,
    createdAt: input.previousDigest?.createdAt ?? now,
    updatedAt: now,
  }
}

async function selectRecentMessages(input: {
  messages: AgentChatContextMessage[]
  triggerUserMessageId: string
  recentMessageBudgetTokens: number
}): Promise<AgentChatContextMessage[]> {
  if (input.recentMessageBudgetTokens <= 0) {
    return input.messages.filter(message => message.id === input.triggerUserMessageId)
  }

  const trimmedMessages = await trimMessages(toLangChainChatMessages(input.messages), {
    maxTokens: input.recentMessageBudgetTokens,
    tokenCounter: messages => defaultAgentTokenEstimator.estimateBaseMessagesTokens(messages).estimatedTokens,
    strategy: 'last',
    allowPartial: false,
  })
  const selected = new Set(trimmedMessages.map(message => message.id).filter(Boolean))

  selected.add(input.triggerUserMessageId)

  return input.messages.filter(message => selected.has(message.id))
}

function trimDigestSummary(summary: string): string {
  if (summary.length <= MAX_DETERMINISTIC_DIGEST_LENGTH) {
    return summary
  }

  return summary.slice(summary.length - MAX_DETERMINISTIC_DIGEST_LENGTH)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
