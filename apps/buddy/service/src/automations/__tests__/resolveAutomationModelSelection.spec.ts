import type { Api, Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { ProviderUnavailableError } from '../../providers/ProviderFailure'
import { resolveAutomationModelSelection } from '../resolveAutomationModelSelection'

describe('resolveAutomationModelSelection', () => {
  it('uses the captured actor model ahead of application defaults and preserves pinned priority', async () => {
    const dependencies = {
      defaults: { getDefaultModel: async () => ({ modelId: 'application', providerId: 'provider', reasoning: null }) },
      models: { resolveAvailable: async () => model(), getServiceTiers: () => [{ id: 'priority' as const, displayName: 'Fast' }] },
    }
    const actorModel = { modelId: 'actor', providerId: 'provider', reasoning: null, serviceTier: 'priority' as const }
    await expect(resolveAutomationModelSelection(dependencies, { mode: 'default' }, actorModel)).resolves.toMatchObject({ modelId: 'actor', serviceTier: 'priority' })
    await expect(resolveAutomationModelSelection(dependencies, { mode: 'default' }, null)).resolves.toMatchObject({ modelId: 'application' })
    await expect(resolveAutomationModelSelection(dependencies, { mode: 'pinned', modelId: 'pinned', providerId: 'provider', reasoning: null }, actorModel)).resolves.toMatchObject({ modelId: 'pinned', serviceTier: null })
  })

  it('rejects an unavailable actor service tier without falling back to application settings', async () => {
    const dependencies = {
      defaults: { getDefaultModel: async () => ({ modelId: 'application', providerId: 'provider', reasoning: null }) },
      models: { resolveAvailable: async () => model(), getServiceTiers: () => [] },
    }
    const actorModel = { modelId: 'actor', providerId: 'provider', reasoning: null, serviceTier: 'priority' as const }
    await expect(resolveAutomationModelSelection(dependencies, { mode: 'default' }, actorModel)).resolves.toBeNull()
    await expect(resolveAutomationModelSelection(dependencies, { mode: 'default' }, { ...actorModel, serviceTier: null })).resolves.toMatchObject({ modelId: 'actor', serviceTier: null })
  })

  it('collapses unavailable or incompatible automation models to no selection', async () => {
    await expect(resolveAutomationModelSelection({
      defaults: { getDefaultModel: () => Promise.resolve(null) },
      models: { resolveAvailable: () => Promise.resolve(model()), getServiceTiers: () => [] },
    }, { mode: 'default' })).resolves.toBeNull()

    await expect(resolveAutomationModelSelection({
      defaults: { getDefaultModel: () => Promise.resolve(null) },
      models: {
        getServiceTiers: () => [],
        resolveAvailable: () => Promise.reject(new ProviderUnavailableError()),
      },
    }, {
      mode: 'pinned',
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: null,
    })).resolves.toBeNull()

    await expect(resolveAutomationModelSelection({
      defaults: { getDefaultModel: () => Promise.resolve(null) },
      models: { resolveAvailable: () => Promise.resolve(model()), getServiceTiers: () => [] },
    }, {
      mode: 'pinned',
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: 'high',
    })).resolves.toBeNull()
  })
})

function model(): Model<Api> {
  return {
    api: 'openai-responses',
    baseUrl: 'https://models.example.test',
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'model-1',
    input: ['text'],
    maxTokens: 16_384,
    name: 'Model 1',
    provider: 'provider-1',
    reasoning: false,
  } as Model<Api>
}
