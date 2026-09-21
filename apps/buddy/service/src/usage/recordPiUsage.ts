import type { Usage } from '@earendil-works/pi-ai'
import type { UsageRecord } from '../storage/usageRepository'

export type BuddyUsagePurpose = 'cache_warm' | 'compaction' | 'tool' | 'turn'

export interface RecordPiUsageInput {
  createdAt: string
  id: string
  model: string
  provider: string
  purpose: BuddyUsagePurpose
  runId: string
  sourceEntryId: string
  usage: Usage
}

export function recordPiUsage(input: RecordPiUsageInput): UsageRecord {
  return {
    cacheReadCost: input.usage.cost.cacheRead,
    cacheReadTokens: input.usage.cacheRead,
    cacheWriteCost: input.usage.cost.cacheWrite,
    cacheWriteTokens: input.usage.cacheWrite,
    createdAt: input.createdAt,
    id: input.id,
    inputCost: input.usage.cost.input,
    inputTokens: input.usage.input,
    model: input.model,
    outputCost: input.usage.cost.output,
    outputTokens: input.usage.output,
    provider: input.provider,
    purpose: input.purpose,
    reasoningTokens: input.usage.reasoning ?? null,
    runId: input.runId,
    sourceEntryId: input.sourceEntryId,
    totalCost: input.usage.cost.total,
    totalTokens: input.usage.totalTokens,
  }
}
