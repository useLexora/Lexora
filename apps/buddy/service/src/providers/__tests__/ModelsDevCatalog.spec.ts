import type { Usage } from '@earendil-works/pi-ai'
import { calculateCost, getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, it } from 'vitest'
import snapshot from '../data/models-dev.json'
import { ModelsDevCatalog } from '../ModelsDevCatalog'

describe('models.dev metadata', () => {
  it('reads individual modalities, prices and raw reasoning levels without inferring PDF from attachment', () => {
    const catalog = new ModelsDevCatalog({ google: { name: 'Google', npm: '@ai-sdk/google', models: {
      multimodal: { name: 'Multimodal', attachment: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], modalities: { input: ['text', 'image', 'audio', 'video'], output: ['text'] }, limit: { context: 200_000, output: 32_000 }, cost: { input: 1.2, cache_read: 0.1 }, tool_call: false },
    } } })
    const model = catalog.getModels()[0]!
    expect(model).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      input: ['text', 'image'],
      pdfInput: false,
      audioInput: true,
      videoInput: true,
      toolCall: false,
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 1.2, output: 0, cacheRead: 0.1, cacheWrite: 0 },
    })
    expect(getSupportedThinkingLevels({ ...model, api: 'google-generative-ai' })).toEqual(['off', 'low', 'high', 'max'])
    expect(model.thinkingLevelMap).toMatchObject({ off: 'none', low: 'low', high: 'high', max: 'max', medium: null })
  })

  it('sends the original disabled reasoning effort through the OpenAI request boundary', async () => {
    const provider = builtinProviders().find(provider => provider.id === 'openai')!
    const source = provider.getModels().find(model => model.id === 'gpt-5.5')!
    const metadata = new ModelsDevCatalog(snapshot.data).getModels('openai').find(model => model.id === source.id)!
    let payload: unknown
    const result = await provider.streamSimple({ ...source, thinkingLevelMap: metadata.thinkingLevelMap }, normalizeContext({ messages: [] }), {
      apiKey: 'fixture-not-a-real-key',
      onPayload: (request) => {
        payload = request
        throw new Error('FIXTURE_PAYLOAD_CAPTURED')
      },
    }).result()
    expect(result.errorMessage).toContain('FIXTURE_PAYLOAD_CAPTURED')
    expect(payload).toMatchObject({ reasoning: { effort: 'none' } })
  })

  it('retains context pricing thresholds and applies them only above the boundary', () => {
    const metadata = new ModelsDevCatalog(snapshot.data).getModels('openai').find(model => model.id === 'gpt-5.4')!
    const model = { ...metadata, api: 'openai-responses' }
    expect(model.cost.tiers).toEqual([{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }])
    const usage = (input: number, cacheRead = 0): Usage => ({
      input,
      output: 1000,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + cacheRead + 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
    expect(calculateCost(model, usage(272_000)).total).toBeCloseTo(0.695)
    expect(calculateCost(model, usage(300_000)).total).toBeCloseTo(1.5225)
    expect(calculateCost(model, usage(272_000, 1)).output).toBeCloseTo(0.0225)
  })

  it('inherits unspecified tier rates and keeps toggle-only off out of protocol effort values', () => {
    const catalog = new ModelsDevCatalog({ fixture: { name: 'Fixture', models: {
      model: {
        name: 'Fixture',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }, { type: 'toggle' }],
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200_000, output: 1000 },
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2, tiers: [{ input: 3, tier: { type: 'context', size: 100_000 } }] },
      },
    } } })
    const model = catalog.getModels()[0]!
    expect(model.cost.tiers).toEqual([{ inputTokensAbove: 100_000, input: 3, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }])
    expect(getSupportedThinkingLevels({ ...model, api: 'anthropic-messages' })).toEqual(['off', 'low', 'high'])
    expect(model.thinkingLevelMap?.off).toBeUndefined()
  })
})
