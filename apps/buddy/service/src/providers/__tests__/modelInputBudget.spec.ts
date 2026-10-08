import type { Model } from '@earendil-works/pi-ai'
import type { InputModel } from '../modelCapabilities'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/bedrock-converse-stream'
import { describe, expect, it } from 'vitest'
import { assertModelRequestBytes, getModelRequestBytesLimit } from '../modelInputBudget'

describe('complete provider input budgets', () => {
  it('enforces model limits for custom endpoints and bounds otherwise unknown endpoints', () => {
    const model = { api: 'openai-completions', inputLimits: { maxRequestBytes: 1024 } } as InputModel
    expect(getModelRequestBytesLimit(model)).toBe(1024)
    expect(() => assertModelRequestBytes(model, { messages: [], tools: [{ description: 'x'.repeat(1024) }] })).toThrow('MODEL_INPUT_TOO_LARGE')
    expect(() => assertModelRequestBytes(model, { messages: [{ role: 'user', content: 'Hello' }] })).not.toThrow()
    expect(getModelRequestBytesLimit({ api: 'openai-completions' })).toBe(32 * 1024 * 1024)
    expect(getModelRequestBytesLimit({ api: 'google-generative-ai' })).toBe(20_000_000)
    expect(getModelRequestBytesLimit({ api: 'anthropic-messages' })).toBe(32_000_000)
    expect(getModelRequestBytesLimit({ api: 'bedrock-converse-stream' })).toBe(20_000_000)
  })

  it.each([
    ['openai-completions', 'messages', 'content', { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    ['openai-responses', 'input', 'content', { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
    ['anthropic-messages', 'messages', 'content', { type: 'tool_result', tool_use_id: 'read', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    ['google-generative-ai', 'contents', 'parts', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
    ['bedrock-converse-stream', 'messages', 'content', { toolResult: { toolUseId: 'read', content: [{ image: { format: 'png', source: { bytes: new Uint8Array([0, 0, 0]) } } }] } }],
  ])('enforces message and request image counts for %s', (api, messageKey, contentKey, image) => {
    const model = { api, inputLimits: { images: { maxPerMessage: 1, maxPerRequest: 2 } } } as InputModel
    const message = { role: 'user', [contentKey]: [image] }
    expect(() => assertModelRequestBytes(model, { [messageKey]: [message, message] })).not.toThrow()
    expect(() => assertModelRequestBytes(model, { [messageKey]: [message, message, message] })).toThrow('MODEL_INPUT_TOO_LARGE')
    expect(() => assertModelRequestBytes(model, { [messageKey]: [{ ...message, [contentKey]: [image, image] }] })).toThrow('MODEL_INPUT_TOO_LARGE')
  })

  it('measures Bedrock images using the actual SDK body encoding without changing its binary parameters', async () => {
    const model: Model<'bedrock-converse-stream'> = { api: 'bedrock-converse-stream', provider: 'amazon-bedrock', id: 'fixture', name: 'Fixture', baseUrl: 'https://example.test', input: ['text', 'image'], contextWindow: 128000, maxTokens: 1024, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const data = Buffer.alloc(64 * 1024, 255).toString('base64')
    let payload: unknown
    const result = await streamSimple(model, normalizeContext({ messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data }], timestamp: 0 }] }), {
      apiKey: 'offline-fixture',
      onPayload: (value) => {
        payload = value
        assertModelRequestBytes(model, value)
        throw new Error('OFFLINE_PAYLOAD_ACCEPTED')
      },
    }).result()
    expect(result.errorMessage).toBe('OFFLINE_PAYLOAD_ACCEPTED')
    const before = structuredClone(payload)
    const { BedrockRuntimeClient, ConverseStreamCommand } = createRequire(import.meta.resolve('@earendil-works/pi-ai'))('@aws-sdk/client-bedrock-runtime')
    let body = ''
    const client = new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint: 'https://example.test',
      credentials: { accessKeyId: 'offline', secretAccessKey: 'offline' },
      maxAttempts: 1,
      requestHandler: {
        handle: async (request: { body: string }) => {
          body = request.body
          throw new Error('OFFLINE_SDK_BODY_CAPTURED')
        },
      },
    })
    try {
      await expect(client.send(new ConverseStreamCommand(payload))).rejects.toThrow('OFFLINE_SDK_BODY_CAPTURED')
    }
    finally {
      client.destroy()
    }
    const bytes = Buffer.byteLength(body, 'utf8')
    expect(bytes).toBeGreaterThan(data.length)
    expect(bytes).toBeLessThan(data.length + 1024)
    expect(JSON.parse(body).messages[0].content[0].image.source.bytes).toBe(data)
    expect(() => assertModelRequestBytes({ ...model, inputLimits: { maxRequestBytes: bytes } }, payload)).not.toThrow()
    expect(() => assertModelRequestBytes({ ...model, inputLimits: { maxRequestBytes: bytes - 1 } }, payload)).toThrow('MODEL_INPUT_TOO_LARGE')
    expect(payload).toEqual(before)
  })
})
