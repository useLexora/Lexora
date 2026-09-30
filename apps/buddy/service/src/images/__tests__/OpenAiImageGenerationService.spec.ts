import type { Model } from '@earendil-works/pi-ai'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import {
  OpenAiImageGenerationService,
  supportsOpenAiImageGeneration,
} from '../OpenAiImageGenerationService'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const imageItem = { id: 'image-call-1', result: png.toString('base64'), status: 'completed', type: 'image_generation_call' }

describe('openAiImageGenerationService', () => {
  it.each(['response.completed', 'response.done', '[DONE]'])('settles %s without waiting for the connection or cancellation cleanup to close', async (type) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start: value => controller = value,
      cancel() {
        cancelled = true
        return new Promise<void>(() => {})
      },
    }))
    const service = streamedService(response)
    const pending = service.generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: new AbortController().signal })
    let settled = false
    void pending.then(() => settled = true, () => settled = true)
    controller.enqueue(new TextEncoder().encode([
      sse({ type: 'response.created', response: { id: 'response-1', status: 'in_progress' } }),
      sse({ type: 'response.output_item.done', item: imageItem }),
      type === '[DONE]' ? 'data: [DONE]\n\n' : sse({ type, response: { id: 'response-1', status: 'completed', output: [imageItem] } }),
    ].join('')))
    try {
      await vi.waitFor(() => expect(settled).toBe(true))
      await expect(pending).resolves.toEqual({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' })
      expect(cancelled).toBe(true)
      expect(response.body?.locked).toBe(false)
    }
    finally {
      if (!cancelled)
        controller.close()
      await pending.catch(() => {})
    }
  })

  it.each(['\n', '\r\n', '\r'])('parses byte-split %j frames, multiline data and the final EOF frame without duplicating images', async (newline) => {
    const text = [
      ': 心跳',
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: imageItem })}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed",',
      `data: "response":${JSON.stringify({ id: 'response-1', status: 'completed', output: [imageItem], metadata: '中文' })}}`,
    ].join(newline)
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length)
          controller.enqueue(bytes.slice(offset, ++offset))
        else
          controller.close()
      },
    }))
    await expect(streamedService(response).generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: new AbortController().signal })).resolves.toEqual({
      images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }],
      responseId: 'response-1',
    })
    expect(response.body?.locked).toBe(false)
  })

  it.each([
    { type: 'error', code: 'provider_failure', message: 'private provider message' },
    { type: 'error', error: { code: 'provider_failure', message: 'private provider message' } },
    ...['response.failed', 'response.incomplete', 'response.cancelled', 'response.done'].map(type => ({
      type,
      response: { status: 'failed', error: { code: 'provider_failure', message: 'private provider message' }, output: [imageItem] },
    })),
  ])('rejects $type immediately even after receiving a completed image', async (event) => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          sse({ type: 'response.output_item.done', item: imageItem }),
          sse(event),
        ].join('')))
      },
      cancel: () => { cancelled = true },
    }), { headers: { 'x-request-id': 'req_image_fixture' } })
    await expect(streamedService(response).generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_FAILED',
      diagnostic: { providerCode: 'provider_failure', requestId: 'req_image_fixture' },
      message: 'Lexora Buddy image generation failed',
    })
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it.each(['eof', 'disconnect'])('reports an unknown result on %s before a response terminal event', async (ending) => {
    let sent = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(sse({ type: 'response.output_item.done', item: imageItem })))
        }
        else if (ending === 'disconnect') {
          controller.error(new Error('private transport failure'))
        }
        else {
          controller.close()
        }
      },
    }), { headers: { 'x-request-id': 'req_image_fixture' } })
    await expect(streamedService(response).generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_INCOMPLETE',
      diagnostic: { requestId: 'req_image_fixture' },
    })
    expect(response.body?.locked).toBe(false)
  })

  it('reports an unknown result and keeps the request id when a JSON response disconnects', async () => {
    let sent = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode('{"status":"completed","output":['))
        }
        else {
          controller.error(new Error('private transport failure'))
        }
      },
    }), { headers: { 'x-request-id': 'req_image_fixture' } })
    await expect(streamedService(response).generate({ inputImages: [], model: openAiModel(), prompt: 'fixture', signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_INCOMPLETE',
      diagnostic: { requestId: 'req_image_fixture' },
      message: 'Lexora Buddy image generation failed',
    })
    expect(response.body?.locked).toBe(false)
  })

  it.each([openAiModel(), codexModel()])('cancels a blocked $api body read without waiting for transport cleanup', async (model) => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
        return new Promise<void>(() => {})
      },
    }))
    const abort = new AbortController()
    const pending = streamedService(response).generate({ inputImages: [], model, prompt: 'fixture', signal: abort.signal })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(response.body?.locked).toBe(true))
    abort.abort()
    await assertion
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it('allows a long-running stream to complete after an hour without a total timeout', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start: value => controller = value }))
    const abort = new AbortController()
    const pending = streamedService(response).generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: abort.signal })
    let settled = false
    void pending.then(() => settled = true, () => settled = true)
    try {
      await vi.waitFor(() => expect(response.body?.locked).toBe(true))
      controller.enqueue(new TextEncoder().encode(sse({ type: 'response.in_progress', response: { id: 'response-1', status: 'in_progress' } })))
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(settled).toBe(false)
      controller.enqueue(new TextEncoder().encode(sse({ type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [imageItem] } })))
      await expect(pending).resolves.toMatchObject({ images: [{ mimeType: 'image/png' }], responseId: 'response-1' })
    }
    finally {
      abort.abort()
      await pending.catch(() => {})
      vi.useRealTimers()
    }
  })

  it.each([
    ['malformed frame', 'data: {invalid}\n\n', 'IMAGE_GENERATION_INVALID_RESPONSE'],
    ['empty terminal', sse({ type: 'response.completed', response: { status: 'completed', output: [] } }), 'IMAGE_GENERATION_FAILED'],
    ['unfinished image', sse({ type: 'response.completed', response: { status: 'completed', output: [{ ...imageItem, status: 'in_progress' }] } }), 'IMAGE_GENERATION_FAILED'],
  ])('rejects %s and releases the stream', async (_name, body, code) => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode(body)),
      cancel: () => { cancelled = true },
    }))
    await expect(streamedService(response).generate({ inputImages: [], model: codexModel(), prompt: 'fixture', signal: new AbortController().signal })).rejects.toMatchObject({ code })
    expect(cancelled).toBe(true)
  })

  it('rejects a failed JSON response even when it contains an earlier image result', async () => {
    const response = Response.json({ status: 'failed', output: [imageItem], error: { code: 'provider_failure', message: 'private failure' } })
    await expect(streamedService(response).generate({ inputImages: [], model: openAiModel(), prompt: 'fixture', signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_FAILED',
      diagnostic: { providerCode: 'provider_failure' },
    })
  })

  it.each(['openai', 'builtin-personal'])('uses the selected instance %s for OpenAI Responses image generation', async (providerId) => {
    const getAuth = vi.fn(async () => ({
      auth: { apiKey: `fixture-key-${providerId}` },
      source: 'API key',
    }))
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'response-1',
      output: [{
        id: 'image-call-1',
        result: png.toString('base64'),
        status: 'completed',
        type: 'image_generation_call',
      }],
      status: 'completed',
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }))
    const service = new OpenAiImageGenerationService({
      fetch: request,
      resolveSourceProviderId: id => id.startsWith('builtin-') ? 'openai' : id,
      modelRuntime: {
        getAuth,
      },
    })
    const model = { ...openAiModel(), provider: providerId }
    const signal = new AbortController().signal

    await expect(service.generate({
      inputImages: [{ data: png.toString('base64'), mimeType: 'image/png', type: 'image' }],
      model,
      prompt: 'Create a Q-style pixel-art mage',
      signal,
    })).resolves.toEqual({
      images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }],
      responseId: 'response-1',
    })
    expect(getAuth).toHaveBeenCalledWith(model, { signal })

    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer fixture-key-${providerId}`)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input: [{
        content: [
          { text: 'Create a Q-style pixel-art mage', type: 'input_text' },
          {
            image_url: `data:image/png;base64,${png.toString('base64')}`,
            type: 'input_image',
          },
        ],
        role: 'user',
      }],
      model: 'gpt-5.6-sol',
      stream: false,
      tool_choice: { type: 'image_generation' },
      tools: [{
        background: 'auto',
        output_format: 'png',
        quality: 'auto',
        size: 'auto',
        type: 'image_generation',
      }],
    })
  })

  it.each(['openai-codex', 'builtin-codex-work'])('uses %s OAuth headers and parses the streamed image result', async (providerId) => {
    const accessToken = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    })
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response([
      `data: ${JSON.stringify({
        item: {
          id: 'image-call-1',
          result: png.toString('base64'),
          status: 'completed',
          type: 'image_generation_call',
        },
        type: 'response.output_item.done',
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), {
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
    }))
    const service = new OpenAiImageGenerationService({
      fetch: request,
      resolveSourceProviderId: id => id === 'builtin-codex-work' ? 'openai-codex' : id,
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: accessToken }, source: 'OAuth' }),
      },
    })

    await expect(service.generate({
      inputImages: [],
      model: { ...codexModel(), provider: providerId },
      prompt: 'Create a new image',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }],
    })

    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`)
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(headers.get('openai-beta')).toBe('responses=experimental')
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true })
  })

  it('exposes the capability only for owned OpenAI Responses providers', () => {
    expect(supportsOpenAiImageGeneration(openAiModel())).toBe(true)
    expect(supportsOpenAiImageGeneration(codexModel())).toBe(true)
    expect(supportsOpenAiImageGeneration({
      ...openAiModel(),
      provider: 'custom-openai-compatible',
    })).toBe(false)
  })

  it('keeps safe provider diagnostics without exposing the provider message', async () => {
    const service = new OpenAiImageGenerationService({
      fetch: async () => new Response(JSON.stringify({
        error: {
          code: 'invalid_value',
          message: 'private provider implementation detail',
          param: 'tools[0].background',
        },
      }), {
        headers: { 'x-request-id': 'req_image_1' },
        status: 400,
      }),
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: 'private-api-key' } }),
      },
    })

    await expect(service.generate({
      inputImages: [],
      model: openAiModel(),
      prompt: 'Create a new image',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_FAILED',
      diagnostic: {
        providerCode: 'invalid_value',
        providerParameter: 'tools[0].background',
        requestId: 'req_image_1',
      },
      message: 'Lexora Buddy image generation failed',
    })
  })

  it('normalizes auth resolver failures', async () => {
    const service = new OpenAiImageGenerationService({
      fetch: vi.fn(),
      modelRuntime: {
        getAuth: async () => {
          throw new Error('private credential resolver failure')
        },
      },
    })

    await expect(service.generate({
      inputImages: [],
      model: openAiModel(),
      prompt: 'Create a new image',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED' })
  })

  it('does not submit an image request when cancellation occurs during authentication', async () => {
    const abort = new AbortController()
    const request = vi.fn()
    const service = new OpenAiImageGenerationService({
      fetch: request,
      modelRuntime: { getAuth: async () => {
        abort.abort()
        return { auth: { apiKey: 'fixture-key' } }
      } },
    })
    await expect(service.generate({ inputImages: [], model: openAiModel(), prompt: 'fixture', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('releases a response arriving after cancellation without reading it', async () => {
    const abort = new AbortController()
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true },
    }))
    const service = new OpenAiImageGenerationService({
      fetch: async () => {
        abort.abort()
        return response
      },
      modelRuntime: { getAuth: async () => ({ auth: { apiKey: 'fixture-key' } }) },
    })
    await expect(service.generate({ inputImages: [], model: openAiModel(), prompt: 'fixture', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it('stops reading an undeclared response once the bounded size is exceeded', async () => {
    let cancelled = false
    let pulls = 0
    const chunk = new Uint8Array(1024 * 1024)
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
      pull(controller) {
        pulls += 1
        if (pulls <= 50)
          controller.enqueue(chunk)
        else
          controller.close()
      },
    })
    const service = new OpenAiImageGenerationService({
      fetch: async () => new Response(body, { status: 200 }),
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: 'private-api-key' } }),
      },
    })

    await expect(service.generate({
      inputImages: [],
      model: openAiModel(),
      prompt: 'Create a new image',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_RESPONSE_TOO_LARGE' })
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(50)
  })
})

function openAiModel(): Model<'openai-responses'> {
  return {
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'gpt-5.6-sol',
    input: ['text', 'image'],
    maxTokens: 16_384,
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    reasoning: true,
  }
}

function codexModel(): Model<'openai-codex-responses'> {
  return {
    ...openAiModel(),
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    provider: 'openai-codex',
  }
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

function streamedService(response: Response) {
  return new OpenAiImageGenerationService({
    fetch: async () => response,
    modelRuntime: { getAuth: async () => ({ auth: { apiKey: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }) } }) },
  })
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
