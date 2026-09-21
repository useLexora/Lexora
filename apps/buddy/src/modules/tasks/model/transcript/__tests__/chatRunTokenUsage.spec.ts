import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import { summarizeRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import { describe, expect, it } from 'vitest'
import { createChatRunTokenUsageReducer } from '../chatRunTokenUsage'

describe('response token usage', () => {
  it('accumulates model calls once and calculates hits against all input tokens', () => {
    const reducer = createChatRunTokenUsageReducer('run')
    const first = usageEvent(1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 300 })
    reducer.append([first])
    const before = reducer.project()
    const warm = usageEvent(4, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 100000, cacheWriteTokens: 0 })
    reducer.append([{ ...warm, payload: { ...(warm.payload as object), purpose: 'cache_warm' } }])
    expect(reducer.project()).toEqual(before)
    reducer.append([
      first,
      usageEvent(2, { inputTokens: 300, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0 }),
      { ...first, runId: 'other-run' },
      usageEvent(3, { inputTokens: -1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }),
    ])
    expect(before).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 300 })
    expect(reducer.project()).toEqual({ inputTokens: 400, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 300 })
    const summary = summarizeRunTokenUsage(reducer.project()!)
    expect(summary).toMatchObject({ inputTokens: 1500, outputTokens: 100, cachedTokens: 800 })
    expect(summary.cacheHitRate).toBeCloseTo(800 / 1500)
  })

  it('distinguishes absent records, zero input, and input without cache hits', () => {
    const reducer = createChatRunTokenUsageReducer('run')
    reducer.append([{ ...usageEvent(1, {}), type: 'usage.recording.degraded' }, usageEvent(2, { inputTokens: 10 })])
    expect(reducer.project()).toBeNull()
    reducer.append([usageEvent(3, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })])
    expect(summarizeRunTokenUsage(reducer.project()!)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheHitRate: null })
    reducer.append([usageEvent(4, { inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })])
    expect(summarizeRunTokenUsage(reducer.project()!).cacheHitRate).toBe(0)
  })
})

function usageEvent(sequence: number, tokens: Record<string, number>): LocalRunEvent {
  return {
    runId: 'run',
    sequence,
    createdAt: '2026-09-09T00:00:00.000Z',
    type: 'usage.recorded',
    payload: { usageRecordId: `usage-${sequence}`, purpose: 'turn', ...tokens },
  }
}
