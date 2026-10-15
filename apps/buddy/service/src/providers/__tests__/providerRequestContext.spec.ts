import type { Api, Model } from '@earendil-works/pi-ai'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { createExtensionModelCapabilities } from '../extensionModelCapabilities'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'

const context = { messages: [{ role: 'user' as const, content: 'Synthetic task', timestamp: 1 }] }

async function fixture(api: Api, compat?: Model<Api>['compat']) {
  const credentials = new InMemoryCredentialStore()
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  const registration = createProviderModelRuntime(runtime, new ProviderRequestHeaders({ getRequestHeaders: () => [] } as never))
  registration.registerProvider('fixture', { name: 'Fixture', api, baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat }] })
  await credentials.modify('fixture', async () => ({ type: 'api_key', key: 'synthetic-key' }))
  const requests: { headers: Headers, body: Record<string, unknown> }[] = []
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Synthetic capture' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return { credentials, runtime, registration, requests, fetch, model: runtime.getModels('fixture')[0]! }
}

describe('provider request context', () => {
  it.each(['openai-completions', 'anthropic-messages', 'openai-responses'] as const)('retains %s routing when caching is disabled without adding unsupported body fields', async (api) => {
    const f = await fixture(api)
    for (const sessionId of ['thread-one', 'thread-one', 'thread-two'])
      await f.runtime.completeSimple(f.model, context, { sessionId, cacheRetention: 'none', fetch: f.fetch })
    expect(f.requests.map(request => request.headers.get('x-session-affinity'))).toEqual(['thread-one', 'thread-one', 'thread-two'])
    expect(f.requests.every(request => !Object.hasOwn(request.body, 'prompt_cache_key'))).toBe(true)
  })

  it('preserves explicit header overrides, deletions and an explicit affinity opt-out', async () => {
    const f = await fixture('openai-completions')
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', headers: { 'X-Session-Affinity': 'caller' }, fetch: f.fetch })
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', headers: { 'X-Session-Affinity': null }, fetch: f.fetch })
    await f.runtime.completeSimple({ ...f.model, compat: { ...f.model.compat, sendSessionAffinityHeaders: false } }, context, { sessionId: 'thread', fetch: f.fetch })
    expect(f.requests.map(request => request.headers.get('x-session-affinity'))).toEqual(['caller', null, null])
  })

  it('adds supported cache keys after payload transformations without mutating or replacing caller keys', async () => {
    const compat = { supportsStore: false, supportsPromptCacheKey: true }
    const f = await fixture('openai-completions', compat)
    const replacement = { model: 'rewritten', messages: [], stream: true }
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', fetch: f.fetch, onPayload: () => replacement })
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', fetch: f.fetch, onPayload: () => ({ ...replacement, prompt_cache_key: 'caller-key' }) })
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', fetch: f.fetch, onPayload: () => ({ ...replacement, prompt_cache_key: null }) })
    await f.runtime.completeSimple(f.model, context, { sessionId: 'thread', cacheRetention: 'none', fetch: f.fetch })
    expect(f.requests.map(request => request.body.prompt_cache_key)).toEqual(['thread', 'caller-key', null, undefined])
    expect(replacement).not.toHaveProperty('prompt_cache_key')
    await f.runtime.completeSimple({ ...f.model, compat: { ...compat, sendSessionAffinityHeaders: false } }, context, { sessionId: 'cache-only', fetch: f.fetch })
    expect(f.requests.at(-1)?.headers.get('x-session-affinity')).toBeNull()
    expect(f.requests.at(-1)?.body.prompt_cache_key).toBe('cache-only')
  })

  it('routes plugin completions through OpenCode while keeping auxiliary identities separate from chat and branches', async () => {
    const f = await fixture('openai-completions')
    f.registration.registerNativeProvider(builtinProviders().find(provider => provider.id === 'opencode-go')!)
    await f.credentials.modify('opencode-go', async () => ({ type: 'api_key', key: 'synthetic-key' }))
    const model = f.runtime.getModels('opencode-go').find(candidate => candidate.api === 'openai-completions')!
    const invocations = vi.fn()
    const transport = { completeSimple: (...[target, input, options]: Parameters<ModelRuntime['completeSimple']>) => f.runtime.completeSimple(target, input, { ...options, fetch: async (_url, init) => {
      f.requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      const chunk = { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Title' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } }) } as ModelRuntime
    const task = { conversationId: 'task', branchId: 'one', model: { providerId: model.provider, modelId: model.id }, assertCurrent() {} }
    const handler = createExtensionModelCapabilities({ resolveSession: async () => ({ model, runtime: transport }) }, {
      record: async () => {
        throw new Error('Incorrect usage owner')
      },
      recordInvocation: invocations,
    }, task)['models.generateText']
    const scope = { conversationId: 'task', runId: null, extensionId: 'tests.title', invocationId: 'invocation', callNumber: 1, signal: new AbortController().signal, action: { id: 'tests.title.generate', cause: { type: 'user' as const } } }
    await handler({ prompt: 'Synthetic title' }, scope)
    await handler({ prompt: 'Synthetic title' }, { ...scope, invocationId: 'second' })
    task.branchId = 'two'
    await handler({ prompt: 'Synthetic title' }, { ...scope, invocationId: 'third' })
    const ids = f.requests.map(request => request.headers.get('x-opencode-session'))
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
    expect(invocations.mock.calls.map(([record]) => record.invocationId)).toEqual(['invocation', 'second', 'third'])
  })
})
