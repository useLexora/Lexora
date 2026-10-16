import type {
  AgentChatContextMessage,
  AgentChatContextSnapshot,
  AgentModelPolicy,
} from '@haohaoxue/lexora-contracts'
import type { AgentHistoryDigest } from './history-compaction'
import {
  defaultAgentTokenEstimator,
} from '../tokens/estimator'

export interface AgentModelLimits {
  contextWindow?: number | null
  maxOutputTokens?: number | null
}

export interface ResolveAgentContextBudgetInput {
  model: AgentModelLimits
  modelPolicy?: Pick<AgentModelPolicy, 'maxOutputTokens'> | null
  systemPrompt: string
  contextSnapshots: Array<Pick<AgentChatContextSnapshot, 'content'>>
  memoryPrompt?: string | null
  historyDigest?: Pick<AgentHistoryDigest, 'summary'> | null
  recentMessages: Array<Pick<AgentChatContextMessage, 'role' | 'content'>>
}

export interface AgentContextBudget {
  contextWindow: number
  reservedOutputTokens: number
  systemPromptTokens: number
  contextSnapshotTokens: number
  memoryPromptTokens: number
  historyDigestTokens: number
  recentMessageTokens: number
  safetyBufferTokens: number
  availableInputTokens: number
  recentMessageBudgetTokens: number
  budgetUsedRatio: number
  compactionThreshold: number
  overflowTokens: number
  estimationSource: 'heuristic'
  safetyMultiplier: number
}

const DEFAULT_CONTEXT_WINDOW = 8192
const DEFAULT_RESERVED_OUTPUT_TOKENS = 2048
const DEFAULT_COMPACTION_THRESHOLD = 0.75

export function resolveAgentContextBudget(input: ResolveAgentContextBudgetInput): AgentContextBudget {
  const contextWindow = readPositiveInteger(input.model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const reservedOutputTokens = Math.min(
    contextWindow - 1,
    readPositiveInteger(input.modelPolicy?.maxOutputTokens)
    ?? readPositiveInteger(input.model.maxOutputTokens)
    ?? Math.min(DEFAULT_RESERVED_OUTPUT_TOKENS, Math.floor(contextWindow * 0.25)),
  )
  const safetyBufferTokens = Math.min(1024, Math.max(256, Math.floor(contextWindow * 0.05)))
  const systemPrompt = defaultAgentTokenEstimator.estimateTextTokens(input.systemPrompt)
  const contextSnapshots = sumTokens(input.contextSnapshots.map(snapshot =>
    defaultAgentTokenEstimator.estimateContextSnapshotTokens(snapshot).estimatedTokens,
  ))
  const memoryPrompt = input.memoryPrompt
    ? defaultAgentTokenEstimator.estimateTextTokens(input.memoryPrompt).estimatedTokens
    : 0
  const historyDigest = input.historyDigest
    ? defaultAgentTokenEstimator.estimateTextTokens(input.historyDigest.summary).estimatedTokens
    : 0
  const recentMessages = defaultAgentTokenEstimator.estimateMessagesTokens(input.recentMessages)
  const availableInputTokens = Math.max(0, contextWindow - reservedOutputTokens - safetyBufferTokens)
  const fixedInputTokens = systemPrompt.estimatedTokens + contextSnapshots + memoryPrompt + historyDigest
  const recentMessageBudgetTokens = Math.max(0, availableInputTokens - fixedInputTokens)
  const usedInputTokens = fixedInputTokens + recentMessages.estimatedTokens
  const budgetUsedRatio = availableInputTokens > 0 ? usedInputTokens / availableInputTokens : 1

  return {
    contextWindow,
    reservedOutputTokens,
    systemPromptTokens: systemPrompt.estimatedTokens,
    contextSnapshotTokens: contextSnapshots,
    memoryPromptTokens: memoryPrompt,
    historyDigestTokens: historyDigest,
    recentMessageTokens: recentMessages.estimatedTokens,
    safetyBufferTokens,
    availableInputTokens,
    recentMessageBudgetTokens,
    budgetUsedRatio,
    compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
    overflowTokens: Math.max(0, recentMessages.estimatedTokens - recentMessageBudgetTokens),
    estimationSource: 'heuristic',
    safetyMultiplier: systemPrompt.safetyMultiplier,
  }
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function sumTokens(tokens: number[]): number {
  return tokens.reduce((total, token) => total + token, 0)
}
