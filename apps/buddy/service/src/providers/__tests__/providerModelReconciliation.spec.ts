import { describe, expect, it } from 'vitest'
import { planModelReconciliation } from '../providerModelReconciliation'
import { createSourceMetadata } from '../providerModelSource'

const before = '2026-11-01T00:00:00.000Z'
const now = '2026-11-14T00:00:00.000Z'
const observation = {
  providerId: 'fixture',
  modelId: 'request-model-id',
  metadata: createSourceMetadata({
    api: 'openai-completions',
    catalogProviderId: null,
    compat: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    displayName: 'Fixture model',
    input: ['text'],
    reasoning: false,
    samplingParams: null,
    sourceContextWindow: 32_000,
    sourceMaxTokens: 4_000,
    thinkingLevelMap: null,
  }),
}

function currentModel() {
  return planModelReconciliation([], [observation], 'synced-complete', before).upserts[0]!
}

describe('model source reconciliation', () => {
  it('only marks missing discovered models unavailable after a complete discovery', () => {
    const current = currentModel()
    const manual = { ...current, modelId: 'manual', source: 'manual' as const }
    expect(planModelReconciliation([current, manual], [], 'synced-partial', now)).toEqual({ upserts: [], unavailable: [] })
    expect(planModelReconciliation([current, manual], [], 'synced-complete', now).unavailable).toEqual([
      { ...current, available: false, updatedAt: now },
    ])
    expect(planModelReconciliation([manual], [{ ...observation, modelId: 'manual' }], 'synced-complete', now).upserts).toEqual([])
  })

  it('refreshes builtin metadata without restoring account availability or seeding new models', () => {
    const current = { ...currentModel(), source: 'builtin' as const, available: false }
    const result = planModelReconciliation([current], [observation, { ...observation, modelId: 'new-model' }], 'builtin-metadata', now)
    expect(result.upserts).toHaveLength(1)
    expect(result.upserts[0]).toMatchObject({ available: false, lastSeenAt: before, source: 'builtin' })
    expect(result.unavailable).toEqual([])
  })
})
