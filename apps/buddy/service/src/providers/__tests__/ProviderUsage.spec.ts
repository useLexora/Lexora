import type { Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { beforeAll, describe, expect, it } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { reconcileOpenAiUsage } from '../providerUsage'
import { withProviderStream } from '../withProviderStream'

const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] })
let provider: Provider
let model: Model<'openai-completions'>

beforeAll(async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  runtime.registerProvider('fixture', {
    api: 'openai-completions',
    baseUrl: 'https://fixture.example.test/v1',
    models: [{ id: 'model', name: 'Model', reasoning: true, input: ['text'], cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 }, contextWindow: 4096, maxTokens: 1024 }],
  })
  provider = runtime.getProvider('fixture')!
  model = runtime.getModels('fixture')[0] as Model<'openai-completions'>
})

async function complete(usages: unknown[], options: { method?: 'stream' | 'streamSimple', failed?: boolean, choiceUsage?: boolean, onProviderStreamEvent?: StreamOptions['onProviderStreamEvent'] } = {}) {
  const diagnostics: ApplicationDiagnostic[] = []
  const chunks = [
    { choices: [{ index: 0, delta: { content: 'private-answer' }, finish_reason: null }] },
    ...usages.map(usage => options.choiceUsage ? { choices: [{ index: 0, delta: {}, usage }] } : { choices: [], usage }),
    options.failed ? { error: { message: 'upstream failure' } } : { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const result = await withProviderStream(provider, record => diagnostics.push(applicationDiagnosticSchema.parse(record)))[options.method ?? 'stream'](model, context, {
    apiKey: 'private-key',
    maxRetries: 0,
    onProviderStreamEvent: options.onProviderStreamEvent,
    fetch: async () => new Response(`${chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  }).result()
  expect(result.stopReason).toBe(options.failed ? 'error' : 'stop')
  return { result, diagnostic: diagnostics.at(-1)!, diagnostics }
}

const exclusive = { prompt_tokens: 100, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 30 }, total_tokens: 135 }

describe('provider usage accounting', () => {
  it.each(['stream', 'streamSimple'] as const)('reconciles separately reported reasoning through %s without mutating upstream evidence', async (method) => {
    const observed: unknown[] = []
    const { result, diagnostic, diagnostics } = await complete([{ ...exclusive, private_field: 'private-usage' }], {
      method,
      onProviderStreamEvent: (event) => {
        const usage = (event as { usage?: object }).usage
        if (usage) {
          Object.freeze(usage)
          observed.push(usage)
        }
      },
    })
    expect(observed).toEqual([{ ...exclusive, private_field: 'private-usage' }])
    expect(result.usage).toMatchObject({ input: 100, output: 35, reasoning: 30, totalTokens: 135 })
    expect(result.usage.cost.output).toBeCloseTo(0.00014)
    expect(result.usage.cost.total).toBeCloseTo(0.00034)
    expect(diagnostic.providerRequest?.usage).toEqual({
      reported: { promptTokens: 100, completionTokens: 5, reasoningTokens: 30, totalTokens: 135 },
      normalized: { inputTokens: 100, outputTokens: 35, reasoningTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 135 },
      reconciliation: 'reasoning_included',
    })
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|fixture.example/)
  })

  it.each([
    { prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } },
    { prompt_cache_hit_tokens: 60, prompt_tokens_details: { cache_write_tokens: 10 } },
    { cached_tokens: 60, prompt_tokens_details: { cache_write_tokens: 10 } },
  ])('preserves cache allocation and prices for %j', async (cache) => {
    const { result, diagnostic } = await complete([{ ...exclusive, ...cache }])
    expect(result.usage).toMatchObject({ input: 30, output: 35, reasoning: 30, cacheRead: 60, cacheWrite: 10, totalTokens: 135 })
    expect(result.usage.cost.total).toBeCloseTo(0.00024)
    expect(diagnostic.providerRequest?.usage?.reported).toMatchObject({ cacheReadTokens: 60, cacheWriteTokens: 10 })
  })

  it('keeps standard inclusive output and absent usage isolated across concurrent requests', async () => {
    const [adapted, standard, absent] = await Promise.all([
      complete([exclusive]),
      complete([{ ...exclusive, completion_tokens: 35 }]),
      complete([]),
    ])
    expect(adapted.result.usage).toEqual(standard.result.usage)
    expect(standard.diagnostic.providerRequest?.usage?.reconciliation).toBe('unchanged')
    expect(absent.result.usage.totalTokens).toBe(0)
    expect(absent.diagnostic.providerRequest?.usage).toBeUndefined()
  })

  it.each([
    { ...exclusive, total_tokens: undefined },
    { ...exclusive, total_tokens: 136 },
    { ...exclusive, total_tokens: 105 },
    { ...exclusive, total_tokens: '135' },
  ])('does not infer reasoning inclusion from ambiguous usage %j', async (usage) => {
    const { result, diagnostic } = await complete([usage])
    expect(result.usage).toMatchObject({ input: 100, output: 5, reasoning: 30, totalTokens: 105 })
    expect(diagnostic).toMatchObject({ level: 'warn', providerRequest: { usage: { reconciliation: 'inconsistent' } } })
  })

  it('uses the final cumulative usage once and preserves a subsequent stream failure', async () => {
    const { result, diagnostic } = await complete([
      { ...exclusive, completion_tokens: 2, total_tokens: 132 },
      exclusive,
      exclusive,
    ], { failed: true })
    expect(result.usage).toMatchObject({ input: 100, output: 35, reasoning: 30, totalTokens: 135 })
    expect(diagnostic).toMatchObject({ event: 'provider.request.failed', providerRequest: { usage: { reconciliation: 'reasoning_included' } } })
  })

  it('does not add reasoning again when the SDK already normalized it', async () => {
    const { result } = await complete([exclusive])
    const reconciled = reconcileOpenAiUsage(model, result, { promptTokens: 100, completionTokens: 5, reasoningTokens: 30, totalTokens: 135 })
    expect(reconciled.message.usage).toEqual(result.usage)
    expect(reconciled.diagnostic.reconciliation).toBe('unchanged')
  })

  it('accepts usage reported on the first choice with the same accounting contract', async () => {
    const { result } = await complete([exclusive], { choiceUsage: true })
    expect(result.usage).toMatchObject({ input: 100, output: 35, reasoning: 30, totalTokens: 135 })
  })
})
