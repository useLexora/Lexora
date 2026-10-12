import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderStateRepository } from '../../storage/providerStateRepository'
import { createBuiltinProviderInstance } from '../createBuiltinProviderInstance'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { OpenAiCompatibleModelDiscovery } from '../ProviderModelDiscovery'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'

describe('provider request headers', () => {
  it('validates input, preserves templates and scopes replacement and deletion by service', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const states = createProviderStateRepository(database)
      for (const providerId of ['first', 'second'])
        states.upsert({ providerId, enabled: false, createdAt: 'now', updatedAt: 'now' })
      const headers = new ProviderRequestHeaders(states)
      const input = [{ name: 'api-key', value: `\${apiKey}` }, { name: 'Authorization', value: '' }, { name: 'X-Label', value: 'visible value' }]
      headers.save('first', input)
      expect(headers.list('first')).toEqual(input)
      expect(headers.resolve('first', { 'authorization': 'old', 'X-Default': 'keep' }, 'test-key')).toEqual({ 'authorization': null, 'api-key': 'test-key', 'x-label': 'visible value', 'x-default': 'keep' })
      expect(headers.resolve('second', { Authorization: 'other' })).toEqual({ authorization: 'other' })
      expect(() => headers.resolve('first')).toThrow(expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }))
      for (const invalid of [
        [{ name: 'bad name', value: 'value' }],
        [{ name: 'Header', value: 'value\r\nInjected: bad' }],
        [{ name: 'Header', value: 'one' }, { name: 'header', value: 'two' }],
      ]) {
        expect(() => headers.save('first', invalid)).toThrow()
        expect(headers.list('first')).toEqual(input)
      }
      headers.save('first', [])
      expect(headers.resolve('first', { Authorization: 'restored' })).toEqual({ authorization: 'restored' })
      headers.save('first', input)
      states.remove('first')
      expect(headers.list('first')).toEqual([])
    }
    finally {
      database.close()
    }
  })

  it('uses headers in discovery, custom inference and native instances without persisting resolved keys', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const credentials = new InMemoryCredentialStore()
      const states = createProviderStateRepository(database)
      const headers = new ProviderRequestHeaders(states)
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const registration = createProviderModelRuntime(runtime, headers)
      const source = builtinProviders().find(provider => provider.id === 'xiaomi-token-plan-cn')!
      registration.registerNativeProvider(source)
      registration.registerNativeProvider(createBuiltinProviderInstance({ id: 'instance', name: 'Instance', source, getCatalogModels: () => source.getModels() }))
      registration.registerProvider('custom', {
        api: 'openai-completions',
        baseUrl: 'https://fixture.example.test/v1',
        name: 'Custom',
        models: [{ id: 'model', name: 'Model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
      })
      const captured: Headers[] = []
      const request: typeof fetch = async (input, init) => {
        captured.push(new Headers(init?.headers))
        if (new URL(String(input)).pathname.endsWith('/models'))
          return Response.json({ data: [{ id: 'model' }] })
        return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'accepted' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      for (const providerId of ['custom', source.id, 'instance']) {
        states.upsert({ providerId, enabled: true, createdAt: 'now', updatedAt: 'now' })
        headers.save(providerId, [{ name: 'API-Key', value: `\${apiKey}` }, { name: 'AUTHORIZATION', value: '' }, { name: 'X-Service', value: providerId }])
        await credentials.modify(providerId, async () => ({ type: 'api_key', key: `fixture-${providerId}` }))
        const model = runtime.getModels(providerId)[0]!
        for (const simple of [true, false]) {
          const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 1 }] }
          const result = await (simple ? runtime.completeSimple(model, context, { fetch: request }) : runtime.complete(model, context, { fetch: request }))
          expect(result.stopReason, result.errorMessage).not.toBe('error')
          expect(captured.at(-1)!.get('authorization')).toBeNull()
          expect(captured.at(-1)!.get('api-key')).toBe(`fixture-${providerId}`)
          expect(captured.at(-1)!.get('x-service')).toBe(providerId)
        }
        expect(JSON.stringify(runtime.getModels(providerId))).not.toContain(`fixture-${providerId}`)
      }
      const discovery = new OpenAiCompatibleModelDiscovery({ credentials, requestHeaders: headers, request })
      await discovery.discover({ providerId: 'custom', api: 'openai-completions', baseUrl: 'https://fixture.example.test/v1' })
      expect(captured.at(-1)!.get('authorization')).toBeNull()
      expect(captured.at(-1)!.get('api-key')).toBe('fixture-custom')
      await credentials.modify('custom', async () => ({ type: 'api_key', key: 'rotated-fixture' }))
      await discovery.discover({ providerId: 'custom', api: 'openai-completions', baseUrl: 'https://fixture.example.test/v1' })
      expect(captured.at(-1)!.get('api-key')).toBe('rotated-fixture')
      expect(headers.list('custom')[0]!.value).toBe(`\${apiKey}`)
    }
    finally {
      database.close()
    }
  })
})
