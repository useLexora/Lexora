import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { describe, expect, it, vi } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { OpenAiCompatibleModelDiscovery } from '../ProviderModelDiscovery'

describe('providerModelDiscovery', () => {
  it.each(['openai-completions', 'openai-responses'])('discovers the standard catalog for %s when client-specific queries return an empty catalog', async (api) => {
    const request = vi.fn(async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(new URL(String(url)).search
      ? { models: [] }
      : {
          data: [
            { id: ' model-1 ', name: ' Model One ' },
            { id: 'model-2' },
          ],
        }))
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: {
        read: () => Promise.resolve({ key: 'test-api-key', type: 'api_key' }),
      },
      request: request as typeof fetch,
    })

    await expect(discovery.discover({
      api,
      baseUrl: 'https://models.example.test/v1',
      providerId: 'example',
    })).resolves.toEqual([
      { id: 'model-1', name: 'Model One' },
      { id: 'model-2' },
    ])
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe('https://models.example.test/v1/models')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-api-key')
  })

  it('requires a local API key before model discovery', async () => {
    const request = vi.fn()
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: () => Promise.resolve(undefined) },
      request: request as typeof fetch,
    })

    await expect(discovery.discover({
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      providerId: 'example',
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    expect(request).not.toHaveBeenCalled()
  })

  it('discovers service capabilities for opaque CPA routes without a provider-specific setting', async () => {
    const ids = ['opaque-alias-high', 'opaque-route']
    const models = ids.map((slug, index) => ({
      slug,
      display_name: `Fixture ${index}`,
      context_window: 200_000 + index,
      max_tokens: 32_000 + index,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    }))
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async () => Response.json({ models }),
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://models.example.test/v1', providerId: 'custom' })).resolves.toEqual(models.map(model => ({
      id: model.slug,
      name: model.display_name,
      metadata: { name: model.display_name, contextWindow: model.context_window, maxTokens: model.max_tokens, input: model.input_modalities, reasoningOptions: ['low', 'high'] },
    })))
  })

  it('reports a successful empty standard catalog without probing other formats', async () => {
    const requests: string[] = []
    const records: ApplicationDiagnostic[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async (url) => {
        requests.push(String(url))
        return Response.json({ data: [] })
      },
      record: record => records.push(applicationDiagnosticSchema.parse(record)),
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://models.example.test/v1/', providerId: 'custom' })).resolves.toEqual([])
    expect(requests).toEqual(['https://models.example.test/v1/models'])
    expect(records.at(-1)).toMatchObject({ event: 'provider.request.completed', count: 0 })
  })

  it.each([
    ...[400, 401, 403, 404, 422, 429, 502].map(status => [status, 'application/json', '{"error":"private-response"}', 'http'] as const),
    [200, 'text/html', '<html>private-response</html>', 'decode'],
    [200, 'application/json', '{"models":["private-model"]}', 'schema'],
  ] as const)('preserves HTTP %s / %s failures without retrying or leaking free-form data', async (status, contentType, body, failureStage) => {
    const records: ApplicationDiagnostic[] = []
    const requests: string[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ type: 'api_key', key: 'private-key' }) },
      request: async (url) => {
        requests.push(String(url))
        return new Response(body, { status, headers: { 'content-type': contentType } })
      },
      record: record => records.push(applicationDiagnosticSchema.parse(record)),
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://private.test/v1', providerId: 'fixture' })).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(requests).toEqual(['https://private.test/v1/models'])
    expect(records.at(-1)).toMatchObject({ providerRequest: { operation: 'models', responseObserved: true, status, failureStage } })
    expect(records[0]?.requestId).toBe(records[1]?.requestId)
    expect(JSON.stringify(records)).not.toContain('private')
  })
})
