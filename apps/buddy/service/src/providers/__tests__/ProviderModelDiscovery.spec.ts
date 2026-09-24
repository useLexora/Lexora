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

    expect(discovery.supports('openai-completions')).toBe(true)
    expect(discovery.supports('openai-responses')).toBe(true)
    expect(discovery.supports('anthropic-messages')).toBe(false)
    await expect(discovery.discover({
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      providerId: 'example',
    })).resolves.toEqual([
      { id: 'model-1', name: 'Model One' },
      { id: 'model-2' },
    ])
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe('https://models.example.test/v1/models')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-api-key')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
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

  it.each([
    [401, 'application/json', '{"error":"private-response"}', 'http'],
    [200, 'text/html', '<html>private-response</html>', 'decode'],
    [200, 'application/json', '{"models":["private-model"]}', 'schema'],
  ])('records HTTP %s and the failed %s stage without free-form data', async (status, contentType, body, failureStage) => {
    const records: ApplicationDiagnostic[] = []
    const discovery = new OpenAiCompatibleModelDiscovery({
      credentials: { read: async () => ({ type: 'api_key', key: 'private-key' }) },
      request: async () => new Response(body, { status, headers: { 'content-type': contentType } }),
      record: record => records.push(applicationDiagnosticSchema.parse(record)),
    })
    await expect(discovery.discover({ api: 'openai-completions', baseUrl: 'https://private.test/v1', providerId: 'fixture' })).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(records.at(-1)).toMatchObject({ providerRequest: { operation: 'models', responseObserved: true, status, failureStage } })
    expect(records[0]?.requestId).toBe(records[1]?.requestId)
    expect(JSON.stringify(records)).not.toContain('private')
  })
})
