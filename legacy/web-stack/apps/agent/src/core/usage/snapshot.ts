import type { ChatGenerationUsageSnapshot } from '@haohaoxue/lexora-contracts'
import type { AgentMemoryRetrievalSnapshot } from '@haohaoxue/lexora-contracts/agent/memory'
import type { BaseMessage } from '@langchain/core/messages'
import type { AgentModelTokenUsage } from '../../integrations/model-providers/stream-text'
import type { AgentContextBudget } from '../context/budget'
import { ChatGenerationUsageSnapshotSchema } from '@haohaoxue/lexora-contracts'
import { defaultAgentTokenEstimator } from '../tokens/estimator'

export interface CreateChatGenerationUsageSnapshotInput {
  inputMessages: BaseMessage[]
  outputText: string
  providerUsage?: AgentModelTokenUsage | null
  contextBudget?: AgentContextBudget | null
  memoryRetrieval?: AgentMemoryRetrievalSnapshot | null
  firstTokenLatencyMs?: number
  elapsedMs: number
}

export function createChatGenerationUsageSnapshot(
  input: CreateChatGenerationUsageSnapshotInput,
): ChatGenerationUsageSnapshot {
  const estimatedInputTokens = defaultAgentTokenEstimator.estimateBaseMessagesTokens(input.inputMessages).estimatedTokens
  const estimatedOutputTokens = defaultAgentTokenEstimator.estimateTextTokens(input.outputText).estimatedTokens
  const providerInputTokens = readTokenCount(input.providerUsage?.inputTokens)
  const providerOutputTokens = readTokenCount(input.providerUsage?.outputTokens)
  const inputTokens = providerInputTokens ?? estimatedInputTokens
  const outputTokens = providerOutputTokens ?? estimatedOutputTokens
  const reasoningTokens = readTokenCount(input.providerUsage?.reasoningTokens) ?? 0
  const totalTokens = readTokenCount(input.providerUsage?.totalTokens) ?? inputTokens + outputTokens
  const estimated = providerInputTokens === null || providerOutputTokens === null
  const usageSource = estimated
    ? providerInputTokens !== null || providerOutputTokens !== null ? 'mixed' : 'estimated'
    : 'provider'

  return ChatGenerationUsageSnapshotSchema.parse({
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    usageSource,
    estimated,
    firstTokenLatencyMs: input.firstTokenLatencyMs,
    tokensPerSecond: calculateTokensPerSecond(outputTokens, input.elapsedMs),
    contextBudget: input.contextBudget ?? undefined,
    memoryRetrieval: input.memoryRetrieval ?? undefined,
  })
}

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
}

function calculateTokensPerSecond(outputTokens: number, elapsedMs: number): number | undefined {
  if (outputTokens <= 0 || elapsedMs <= 0) {
    return undefined
  }

  return Number((outputTokens / (elapsedMs / 1000)).toFixed(2))
}
