import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { ChatProjectionReducer } from './chatRunEventProjection'
import { runTokenUsageSchema } from '@buddy-shared/usage/runTokenUsage'
import { z } from 'zod'

const recordedUsageSchema = runTokenUsageSchema.extend({
  purpose: z.string().optional(),
  usageRecordId: z.string().min(1),
}).strip()

export function createChatRunTokenUsageReducer(runId: string): ChatProjectionReducer<LocalRunTokenUsage | null> {
  const recordedIds = new Set<string>()
  let usage: LocalRunTokenUsage | null = null
  return {
    append(events) {
      for (const event of events) {
        if (event.runId !== runId || event.type !== 'usage.recorded')
          continue
        const parsed = recordedUsageSchema.safeParse(event.payload)
        if (!parsed.success || parsed.data.purpose === 'cache_warm' || recordedIds.has(parsed.data.usageRecordId))
          continue
        const record = parsed.data
        recordedIds.add(record.usageRecordId)
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + record.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + record.outputTokens,
          cacheReadTokens: (usage?.cacheReadTokens ?? 0) + record.cacheReadTokens,
          cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + record.cacheWriteTokens,
        }
      }
    },
    project: () => usage,
  }
}
