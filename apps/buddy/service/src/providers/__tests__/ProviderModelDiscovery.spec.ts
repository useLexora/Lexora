import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { describe, expect, it, vi } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { OpenAiCompatibleModelDiscovery } from '../ProviderModelDiscovery'

describe('providerModelDiscovery', () => {
  it('discovers and normalizes models through the OpenAI-compatible protocol', async () => {
    const request = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      data: [
        { id: ' model-1 ', name: ' Model One ' },
        { id: 'model-2' },
      ],
    }), { status: 200 }))
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: {
        read: () => Promise.resolve({ key: 'test-api-key', type: 'api_key' }),
      },
      request: request as typeof fetch,
    })

    await expect(discovery.discover({
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      providerId: 'example',
    })).resolves.toEqual([
      { id: 'model-1', name: 'Model One' },
      { id: 'model-2' },
    ])
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe('https://models.example.test/v1/models?client_version=pi')
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

  it.each([400, 404, 422])('uses the standard catalog when the service rejects discovery parameters with HTTP %s', async (status) => {
    const requests: string[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async (url) => {
        requests.push(String(url))
        return new URL(String(url)).search ? Response.json({ error: 'unsupported query' }, { status }) : Response.json({ data: [{ id: 'route-high' }] })
      },
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://models.example.test/v1', providerId: 'custom' })).resolves.toEqual([{ id: 'route-high' }])
    expect(requests).toEqual(['https://models.example.test/v1/models?client_version=pi', 'https://models.example.test/v1/models'])
  })

  it.each([
    ...[401, 403, 429, 502].map(status => [status, 'application/json', '{"error":"private-response"}', 'http'] as const),
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
    expect(requests).toEqual(['https://private.test/v1/models?client_version=pi'])
    expect(records.at(-1)).toMatchObject({ providerRequest: { operation: 'models', responseObserved: true, status, failureStage } })
    expect(records[0]?.requestId).toBe(records[1]?.requestId)
    expect(JSON.stringify(records)).not.toContain('private')
  })
})
