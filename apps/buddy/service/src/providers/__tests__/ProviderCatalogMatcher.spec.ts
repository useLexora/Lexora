import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { ModelsDevCatalog } from '../ModelsDevCatalog'
import { ProviderCatalogMatcher } from '../ProviderCatalogMatcher'

describe('providerCatalogMatcher', () => {
  it('merges exact reference candidates by field while distinguishing unknown support from explicit conflicts', () => {
    const first = { ...model('vendor', 'instruct', 'https://vendor.test'), toolCall: true }
    const unknown = { ...first, id: 'unknown', toolCall: undefined }
    const conflicting = { ...first, id: 'base', toolCall: false }
    const matcher = new ProviderCatalogMatcher(catalogRuntime([first, unknown, conflicting]))
    const references = (ids: string[]) => ids.map(modelId => ({ providerId: 'vendor', modelId }))
    expect(matcher.matchReferences(references(['missing']))).toEqual({ status: 'unmatched', candidates: [] })
    expect(matcher.matchReferences(references(['missing', 'instruct']))).toMatchObject({ status: 'matched', model: { toolCall: true } })
    for (const ids of [['unknown', 'instruct'], ['instruct', 'unknown']])
      expect(matcher.matchReferences(references(ids))).toMatchObject({ status: 'ambiguous', defaults: { toolCall: true, contextWindow: first.contextWindow } })
    const conflict = matcher.matchReferences(references(['instruct', 'base']))
    expect(conflict).toMatchObject({ status: 'ambiguous', defaults: { contextWindow: first.contextWindow } })
    if (conflict.status === 'ambiguous')
      expect(conflict.defaults.toolCall).toBeUndefined()
    expect(matcher.matchReferences(references(['unknown']))).toMatchObject({ status: 'matched', model: { toolCall: undefined } })
    expect(matcher.matchReferences(references(['base']))).toMatchObject({ status: 'matched', model: { toolCall: false } })
  })

  it('reuses content-identical catalogs and replaces indexed candidates when metadata changes', () => {
    const raw = (context: number) => ({ vendor: { name: 'Vendor', api: 'https://vendor.example.test', models: {
      shared: { name: 'Shared', modalities: { input: ['text'], output: ['text'] }, limit: { context, output: 4096 } },
    } } })
    let current = new ModelsDevCatalog(raw(32_000))
    const matcher = new ProviderCatalogMatcher({ getFingerprint: () => current.getFingerprint(), getModels: id => current.getModels(id), getProviders: () => current.getProviders() })
    const input = { api: 'openai-completions', baseUrl: 'https://vendor.example.test', modelId: 'shared' }
    const first = matcher.match(input)
    expect(first).toMatchObject({ status: 'matched', model: { contextWindow: 32_000 } })
    current = new ModelsDevCatalog(raw(32_000))
    expect(matcher.match(input)).toBe(first)
    current = new ModelsDevCatalog(raw(64_000))
    expect(matcher.match(input)).toMatchObject({ status: 'matched', model: { contextWindow: 64_000 } })
    expect(matcher.find({ providerId: 'vendor', modelId: 'shared' })?.contextWindow).toBe(64_000)
  })

  it('requires selection when otherwise equal metadata disagrees on input or tool capabilities', () => {
    for (const capabilities of [{ input: ['text', 'image'] as Array<'text' | 'image'> }, { toolCall: true }]) {
      const first = { ...model('first', 'shared', 'https://first.example.test'), toolCall: false }
      const second = { ...model('second', 'shared', 'https://second.example.test'), toolCall: false, ...capabilities }
      const matcher = new ProviderCatalogMatcher(catalogRuntime([first, second]))
      const input = { api: 'openai-completions', baseUrl: 'https://relay.example.test', modelId: 'shared' }
      expect(matcher.match(input)).toMatchObject({ status: 'ambiguous', candidates: [{ provider: 'first' }, { provider: 'second' }] })
      expect(matcher.match({ ...input, selection: { providerId: 'second', modelId: 'shared' } }))
        .toMatchObject({ status: 'matched', model: second })
    }
  })

  it('collapses equal capabilities deterministically without treating reseller prices as capability conflicts', () => {
    const first = model('first', 'shared', 'https://first.example.test')
    const second = { ...model('second', 'shared', 'https://second.example.test'), cost: { ...first.cost, input: 10 } }
    for (const models of [[first, second], [second, first]]) {
      const matcher = new ProviderCatalogMatcher(catalogRuntime(models))
      expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://custom.example.test', modelId: 'shared' }))
        .toMatchObject({ status: 'matched', model: { provider: 'first' } })
    }
  })

  it('prefers the normalized endpoint over the original vendor and the original vendor over resellers', () => {
    const matcher = new ProviderCatalogMatcher(catalogRuntime([
      model('proxy', 'deepseek-v4-flash', 'https://proxy.example.test/v1/'),
      { ...model('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.test'), contextWindow: 256_000 },
    ]))
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://custom.example.test', modelId: 'deepseek-v4-flash' }))
      .toMatchObject({ status: 'matched', model: { provider: 'deepseek' } })
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://proxy.example.test', modelId: 'deepseek-v4-flash' }))
      .toMatchObject({ status: 'matched', model: { provider: 'proxy' } })
  })

  it('matches controlled namespace aliases without dropping model versions', () => {
    const matcher = new ProviderCatalogMatcher(catalogRuntime([
      model('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.test'),
    ]))
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://custom.example.test', modelId: 'DeepSeek-AI/DeepSeek-V4-Flash' }))
      .toMatchObject({ status: 'matched', model: { provider: 'deepseek' } })
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://custom.example.test', modelId: 'deepseek-v4-flash-0731' }))
      .toMatchObject({ status: 'unmatched' })
  })

  it('keeps an endpoint-scoped alias ahead of a global exact ID', () => {
    const matcher = new ProviderCatalogMatcher(catalogRuntime([
      model('proxy', 'deepseek-ai/deepseek-v4-flash', 'https://proxy.example.test'),
      model('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.test'),
    ]))
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://proxy.example.test', modelId: 'deepseek-v4-flash' }))
      .toMatchObject({ status: 'matched', model: { provider: 'proxy' } })
  })

  it('preserves explicit selection priority and does not substitute a missing source', () => {
    const matcher = new ProviderCatalogMatcher(catalogRuntime([
      model('proxy', 'deepseek-v4-flash', 'https://proxy.example.test'),
      model('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.test'),
    ]))
    const input = { api: 'openai-responses', baseUrl: 'https://api.deepseek.test', modelId: 'deepseek-v4-flash' }
    expect(matcher.match({ ...input, selection: { providerId: 'proxy', modelId: input.modelId } }))
      .toMatchObject({ status: 'matched', model: { provider: 'proxy' } })
    expect(matcher.match({ ...input, selection: { providerId: 'missing', modelId: input.modelId } }))
      .toMatchObject({ status: 'unmatched' })
  })

  it('recovers a channel namespace through a first-party rolling name without conflating versions', () => {
    const official = { ...model('deepseek', 'deepseek-flash', 'https://api.deepseek.test'), name: 'DeepSeek V4.1 Flash 1017', input: ['text', 'image'] as Array<'text' | 'image'> }
    const reseller = model('reseller', 'deepseek-v4.1-flash', 'https://reseller.test')
    const matcher = new ProviderCatalogMatcher(catalogRuntime([official, reseller]))
    const input = { api: 'openai-completions', baseUrl: 'https://relay.test', modelId: 'workbuddy/deepseek-v4.1-flash' }
    expect(matcher.match(input)).toMatchObject({ status: 'matched', model: official })
    expect(matcher.match({ ...input, baseUrl: reseller.baseUrl })).toMatchObject({ status: 'matched', model: reseller })
    expect(matcher.match({ ...input, selection: { providerId: reseller.provider, modelId: reseller.id } })).toMatchObject({ status: 'matched', model: reseller })
    for (const modelId of ['workbuddy/deepseek-v4-flash', 'workbuddy/deepseek-v4.1-pro', 'workbuddy/deepseek-v4.1-flash-0901', '@gateway/deepseek-v4.1-flash', 'a/b/deepseek-v4.1-flash'])
      expect(matcher.match({ ...input, modelId }), modelId).toMatchObject({ status: 'unmatched' })
    const untrusted = new ProviderCatalogMatcher(catalogRuntime([{ ...official, provider: 'reseller' }]))
    expect(untrusted.match(input)).toMatchObject({ status: 'unmatched' })
  })

  it('recovers Gemini effort suffix metadata only when the full ID is absent', () => {
    const official = { ...model('google', 'gemini-3.8-flash', 'https://google.test'), input: ['text', 'image'] as Array<'text' | 'image'> }
    const matcher = new ProviderCatalogMatcher(catalogRuntime([official]))
    const connection = { api: 'openai-completions', baseUrl: 'https://relay.test' }
    for (const effort of ['minimal', 'low', 'medium', 'high']) {
      const input = { ...connection, modelId: `cpa/gemini-3.8-flash-${effort}` }
      expect(matcher.match(input), effort).toMatchObject({ status: 'matched', model: official })
      const exact = model('reseller', input.modelId, input.baseUrl)
      expect(new ProviderCatalogMatcher(catalogRuntime([official, exact])).match(input), effort).toMatchObject({ status: 'matched', model: exact })
    }
    for (const modelId of ['gemini-3.8-flash-lite-high', 'gemini-3.8-flash-0901-high', 'gemini-3.8-flash-preview', 'gemini-3.8-flash-ultra', 'gemini-3.8-flash-high-high'])
      expect(matcher.match({ ...connection, modelId }), modelId).toEqual({ candidates: [], status: 'unmatched' })
  })

  it('retains unanimous fields without choosing a provider or voting away conflicts', () => {
    const first = { ...model('first', 'shared', 'https://first.test'), input: ['text', 'image'] as Array<'text' | 'image'>, contextWindow: 256_000, maxTokens: 32_000 }
    const second = { ...first, provider: 'second', baseUrl: 'https://second.test', contextWindow: 512_000 }
    const input = { api: 'openai-completions', baseUrl: 'https://relay.test', modelId: 'gateway/shared' }
    const match = new ProviderCatalogMatcher(catalogRuntime([first, second])).match(input)
    expect(match).toMatchObject({ status: 'ambiguous', defaults: { input: ['text', 'image'], maxTokens: 32_000 } })
    if (match.status === 'ambiguous') {
      expect(match.defaults).not.toHaveProperty('contextWindow')
      expect(match.defaults).not.toHaveProperty('baseUrl')
    }
    const conflict = new ProviderCatalogMatcher(catalogRuntime([first, second, { ...second, provider: 'third', input: ['text'] }])).match(input)
    expect(conflict).toMatchObject({ status: 'ambiguous' })
    if (conflict.status === 'ambiguous')
      expect(conflict.defaults).not.toHaveProperty('input')
  })

  it('matches model metadata independently of the execution protocol', () => {
    const matcher = new ProviderCatalogMatcher(catalogRuntime([
      { ...model('anthropic', 'claude-sonnet', 'https://api.anthropic.test'), api: 'anthropic-messages' },
    ]))
    expect(matcher.match({ api: 'openai-responses', baseUrl: 'https://custom.example.test', modelId: 'claude-sonnet' }))
      .toMatchObject({ status: 'matched', model: { provider: 'anthropic' } })
  })
})

function catalogRuntime(models: Array<Model<Api> & { toolCall?: boolean }>) {
  const providerIds = [...new Set(models.map(model => model.provider))]
  return {
    getModels: (providerId?: string) => providerId
      ? models.filter(model => model.provider === providerId)
      : models,
    getProviders: () => providerIds.map(id => ({ id, name: id } as Provider)),
  }
}

function model(provider: string, id: string, baseUrl: string): Model<Api> {
  return {
    api: 'openai-responses',
    baseUrl,
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ['text'],
    maxTokens: 16_384,
    name: id,
    provider,
    reasoning: false,
  }
}
