import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { describe, expect, it, vi } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { OpenAiCompatibleModelDiscovery } from '../ProviderModelDiscovery'

describe('providerModelDiscovery', () => {
  it('discovers normalized standard IDs through the authenticated models endpoint', async () => {
    const request = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({
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
      api: 'openai-completions',
      baseUrl: 'https://models.example.test/v1',
      providerId: 'example',
    })).resolves.toEqual({
      complete: true,
      models: [
        { id: 'model-1', name: 'Model One' },
        { id: 'model-2' },
      ],
    })
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
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://models.example.test/v1', providerId: 'custom' })).resolves.toEqual({
      complete: true,
      models: models.map(model => ({
        id: model.slug,
        name: model.display_name,
        metadata: { name: model.display_name, contextWindow: model.context_window, maxTokens: model.max_tokens, input: model.input_modalities, reasoningOptions: ['low', 'high'] },
      })),
    })
  })

  it('reads whitelisted metadata in standard entries without accepting instructions or request configuration', async () => {
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async () => Response.json({ data: [{
        id: 'gemini-3.8-flash-high',
        input_modalities: ['text', 'image', 'image'],
        context_window: 128_000,
        max_tokens: 8_000,
        supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }, { effort: 'ultra' }],
        base_instructions: 'untrusted',
        headers: { authorization: 'untrusted' },
      }] }),
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://models.example.test/v1', providerId: 'custom' })).resolves.toEqual({
      complete: true,
      models: [{
        id: 'gemini-3.8-flash-high',
        metadata: { input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_000, reasoningOptions: ['off', 'high', 'ultra'] },
      }],
    })
  })

  it.each([
    { label: 'has_more', body: { data: [{ id: 'observed' }], has_more: true } },
    { label: 'hasMore', body: { data: [{ id: 'observed' }], hasMore: true } },
    { label: 'ambiguous flag', body: { data: [{ id: 'observed' }], has_more: 'false' } },
    { label: 'partial', body: { data: [{ id: 'observed' }], partial: true } },
    { label: 'truncated', body: { data: [{ id: 'observed' }], truncated: true } },
    ...['next', 'next_page', 'next_cursor', 'next_page_token', 'nextPageToken'].map(key => ({ label: key, body: { data: [{ id: 'observed' }], [key]: 'continuation' } })),
    { label: 'nested next link', body: { data: [{ id: 'observed' }], links: { next: '/models?page=2' } } },
    { label: 'previous page link', body: { data: [{ id: 'observed' }], links: { prev: '/models?page=1' } } },
    { label: 'unknown pagination', body: { data: [{ id: 'observed' }], pagination: {} } },
    { label: 'larger total', body: { data: [{ id: 'observed' }], total: 2 } },
    { label: 'inconsistent total', body: { data: [{ id: 'observed' }], total_count: 0 } },
    { label: 'noninitial offset', body: { data: [{ id: 'observed' }], offset: 1 } },
    { label: 'last page', body: { data: [{ id: 'observed' }], has_more: false, page: 2 } },
    { label: '206', body: { data: [{ id: 'observed' }] }, status: 206 },
    { label: 'content range', body: { data: [{ id: 'observed' }] }, headers: { 'content-range': 'items 0-0/2' } },
    { label: 'HTTP link', body: { data: [{ id: 'observed' }] }, headers: { link: '<https://untrusted.test/models>; rel="next"' } },
    { label: 'extended catalog', body: { models: [{ slug: 'observed' }], has_more: true } },
  ])('keeps observed models but marks $label results incomplete', async ({ body, status, headers }: { body: unknown } & ResponseInit) => {
    const requests: string[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async (url) => {
        requests.push(String(url))
        return Response.json(body, { status, headers })
      },
    })
    const result = await discovery.discover({ api: 'openai-completions', baseUrl: 'https://fixture.test/v1', providerId: 'fixture' })
    expect(result).toMatchObject({ complete: false, models: [{ id: 'observed' }] })
    expect(requests).toEqual(['https://fixture.test/v1/models'])
  })

  it.each([
    { data: [] },
    { data: [{ id: 'observed' }], has_more: false, next: null, next_page: '', links: { next: null }, total: 1 },
    { models: [], total_count: 0 },
  ])('recognizes complete standard and extended catalogs including empty lists: %j', async (body) => {
    const requests: string[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ key: 'fixture-key', type: 'api_key' }) },
      request: async (url) => {
        requests.push(String(url))
        return Response.json(body)
      },
    })
    await expect(discovery.discover({ api: 'openai-responses', baseUrl: 'https://fixture.test/v1/', providerId: 'fixture' })).resolves.toEqual({ complete: true, models: body.data ?? [] })
    expect(requests).toEqual(['https://fixture.test/v1/models'])
  })

  it.each([
    ...[401, 429, 502].map(status => [status, 'application/json', '{"error":"private-response"}', 'http'] as const),
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
