import type { ProviderService } from '../../providers/ProviderService'
import type { ImageGenerationInput } from '../ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { Check } from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createImageGenerationParameters } from '../imageGenerationToolParameters'
import { imageResponseDiagnostic } from '../imageHttpDiagnostic'
import { ProviderImageService } from '../ProviderImageService'
import { RoutedImageGateway } from '../RoutedImageGateway'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const providerId = 'image-fixture'
const modelId = 'image-model'
const agnes = 'https://apihub.agnes-ai.com/v1'

function input(overrides: Partial<ImageGenerationInput> = {}): ImageGenerationInput {
  return {
    prompt: 'a red teapot',
    inputImages: [],
    signal: new AbortController().signal,
    model: { id: 'chat-model', provider: providerId } as ImageGenerationInput['model'],
    ...overrides,
  }
}

function fixture(baseUrl: string) {
  const requests: Array<{ url: string, headers: Headers, body: string | FormData }> = []
  const providers = {
    listModels: async () => [{ id: modelId, providerId, displayName: 'Image fixture', enabled: true, available: true, type: 'image-generation', api: 'openai-images' }],
    listProviders: async () => [{ id: providerId, enabled: true, status: 'available', baseUrl, requestHeaders: [] }],
    getCredentialMetadata: () => ({ type: 'api_key', revision: 1 }),
    prepareModelRequest: async () => ({ baseUrl, headers: { 'authorization': 'Bearer fixture-credential', 'content-type': 'application/json' } }),
  } as unknown as ProviderService
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body as string | FormData })
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture' } })
  }
  return { requests, providers, service: new ProviderImageService(providers, fetch) }
}

describe('provider image protocols', () => {
  it('preserves OpenAI Images generation and PNG response parsing', async () => {
    const f = fixture('https://images.example/v1/')
    const result = await f.service.generate(providerId, modelId, input({ output: { size: '1024x1024', quality: 'medium', background: 'transparent' } }))
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.url).toBe('https://images.example/v1/images/generations')
    expect(JSON.parse(f.requests[0]!.body as string)).toEqual({ model: modelId, prompt: 'a red teapot', n: 1, output_format: 'png', size: '1024x1024', quality: 'medium', background: 'transparent' })
    expect(result).toEqual({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'req_fixture' })
  })

  it('preserves OpenAI multipart editing without a JSON content type', async () => {
    const f = fixture('https://images.example/v1')
    await f.service.generate(providerId, modelId, input({ inputImages: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }))
    const request = f.requests[0]!
    expect(request.url).toBe('https://images.example/v1/images/edits')
    expect(request.headers.has('content-type')).toBe(false)
    const form = request.body as FormData
    expect(form.get('output_format')).toBe('png')
    expect(form.get('n')).toBe('1')
    expect(Buffer.from(await (form.get('image[]') as File).arrayBuffer())).toEqual(png)
  })

  it.each([agnes, `${agnes}/`, 'https://api.agnes-ai.cn/v1'])('uses the Agnes protocol at %s without changing the requested model', async (baseUrl) => {
    const f = fixture(baseUrl)
    await f.service.generate(providerId, modelId, input())
    expect(JSON.parse(f.requests[0]!.body as string)).toEqual({ model: modelId, prompt: 'a red teapot', size: '1K', ratio: '1:1', extra_body: { response_format: 'b64_json' } })
    expect(f.requests[0]!.headers.get('content-type')).toBe('application/json')
  })

  it('sends Agnes reference images and geometry through the generations endpoint', async () => {
    const f = fixture(agnes)
    await f.service.generate(providerId, modelId, input({
      output: { resolution: '2K', aspectRatio: '3:2' },
      inputImages: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
    }))
    expect(f.requests[0]!.url).toBe(`${agnes}/images/generations`)
    expect(JSON.parse(f.requests[0]!.body as string)).toEqual({
      model: modelId,
      prompt: 'a red teapot',
      size: '2K',
      ratio: '3:2',
      extra_body: { response_format: 'b64_json', image: [`data:image/png;base64,${png.toString('base64')}`] },
    })
  })

  it('preserves explicit pixel-size requests without inventing a conflicting ratio', async () => {
    const f = fixture(agnes)
    await f.service.generate(providerId, modelId, input({ output: { size: '1536x1024' } }))
    expect(JSON.parse(f.requests[0]!.body as string)).toEqual({ model: modelId, prompt: 'a red teapot', size: '1536x1024', extra_body: { response_format: 'b64_json' } })
  })

  it.each([{ quality: 'medium' as const }, { background: 'transparent' as const }])('rejects unsupported Agnes output before submitting: %j', async (output) => {
    const f = fixture(agnes)
    await expect(f.service.generate(providerId, modelId, input({ output }))).rejects.toMatchObject({ code: 'IMAGE_GENERATION_UNSUPPORTED' })
    expect(f.requests).toEqual([])
  })

  it('rejects mixed pixel and tier geometry and excessive references before submission', async () => {
    const f = fixture(agnes)
    await expect(f.service.generate(providerId, modelId, input({ output: { size: '1024x1024', resolution: '2K' } }))).rejects.toThrow('Pixel size cannot be combined')
    await expect(f.service.generate(providerId, modelId, input({ inputImages: Array.from({ length: 7 }, () => ({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })) }))).rejects.toMatchObject({ code: 'IMAGE_GENERATION_UNSUPPORTED' })
    expect(f.requests).toEqual([])
  })

  it.each(['https://apihub.agnes-ai.com.example/v1', 'https://proxy.example/v1', 'https://apihub.agnes-ai.com/v1/another'])('does not guess an Agnes protocol for %s', async (baseUrl) => {
    const f = fixture(baseUrl)
    await f.service.generate(providerId, modelId, input())
    expect(JSON.parse(f.requests[0]!.body as string)).toEqual({ model: modelId, prompt: 'a red teapot', n: 1, output_format: 'png' })
  })

  it('advertises and enforces the same provider-specific tool parameters', async () => {
    const f = fixture(agnes)
    const gateway = new RoutedImageGateway({
      native: { supports: () => false, generate: async () => { throw new Error('Unexpected native route') } },
      providers: f.providers,
      preferences: async () => ({ generate: { mode: 'selected', target: { kind: 'model', providerId, modelId }, fallbacks: [] } }),
    })
    const description = await gateway.describe({ model: input().model })
    expect(description.generate[0]!.support).toMatchObject({ qualities: ['auto'], backgrounds: ['auto'], resolutions: ['1K', '2K', '3K', '4K'] })
    const schema = createImageGenerationParameters(description)
    const args = { prompt: 'fixture', outputPath: 'fixture.png' }
    expect(Check(schema, args)).toBe(true)
    expect(Check(schema, { ...args, output: { resolution: '2K', aspectRatio: '16:9' } })).toBe(true)
    expect(Check(schema, { ...args, output: { size: '1536x1024' } })).toBe(true)
    expect(Check(schema, { ...args, output: { resolution: '2K', background: 'transparent' } })).toBe(false)
    expect(Check(schema, { ...args, output: { size: '1536x1024', resolution: '2K' } })).toBe(false)
    await expect(gateway.generate(input({ output: { quality: 'high' } }))).rejects.toMatchObject({ code: 'IMAGE_GENERATION_UNSUPPORTED' })
  })

  it('extracts a known rejected parameter without exposing provider response prose', () => {
    const diagnostic = imageResponseDiagnostic(new Response(null, { status: 400, headers: { 'content-type': 'application/json' } }), {
      error: { code: 'invalid_request', param: '', message: 'output_format is not supported by text image queue (private details)' },
    })
    expect(diagnostic).toMatchObject({ httpStatus: 400, providerCode: 'invalid_request', providerParameter: 'output_format' })
    expect(JSON.stringify(diagnostic)).not.toContain('private details')
    const unknown = imageResponseDiagnostic(new Response(null, { status: 400 }), { error: { message: 'private-secret is not supported' } })
    expect(unknown).not.toHaveProperty('providerParameter')
  })
})
