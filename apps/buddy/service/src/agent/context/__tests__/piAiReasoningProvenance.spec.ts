import type { Context, Model } from '@earendil-works/pi-ai'
import { Buffer } from 'node:buffer'
import { normalizeContext } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { describe, expect, it } from 'vitest'

const context: Context = {
  messages: [],
  systemPrompt: 'Test',
  tools: [],
}

const model = {
  api: 'openai-codex-responses',
  baseUrl: 'https://example.test/backend-api',
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: 'test-codex',
  input: ['text'],
  maxTokens: 16_384,
  name: 'Test Codex',
  provider: 'openai-codex',
  reasoning: true,
} satisfies Model<'openai-codex-responses'>

describe('patched Pi OpenAI text phase', () => {
  it('attaches the Responses message phase before text deltas begin', async () => {
    const messageItem = {
      content: [{ text: 'Checking the current process', type: 'output_text' }],
      id: 'message-commentary',
      phase: 'commentary',
      role: 'assistant',
      status: 'completed',
      type: 'message',
    }
    const response = stream(model, normalizeContext(context), {
      apiKey: token(),
      fetch: async () => sseResponse([
        { response: { id: 'response-2' }, type: 'response.created' },
        {
          item: { ...messageItem, content: [], status: 'in_progress' },
          output_index: 0,
          type: 'response.output_item.added',
        },
        {
          delta: 'Checking the current process',
          output_index: 0,
          type: 'response.output_text.delta',
        },
        { item: messageItem, output_index: 0, type: 'response.output_item.done' },
        {
          response: {
            id: 'response-2',
            output: [messageItem],
            status: 'completed',
            usage: usage(),
          },
          type: 'response.completed',
        },
      ]),
      maxRetries: 0,
      transport: 'sse',
    })
    const signatures: unknown[] = []
    for await (const event of response) {
      if (event.type !== 'text_start' && event.type !== 'text_delta')
        continue
      const content = event.partial.content[event.contentIndex]
      signatures.push(content?.type === 'text' && content.textSignature
        ? JSON.parse(content.textSignature)
        : null)
    }

    expect(signatures).toEqual([
      { id: 'message-commentary', phase: 'commentary', v: 1 },
      { id: 'message-commentary', phase: 'commentary', v: 1 },
    ])
  })
})

function sseResponse(events: ReadonlyArray<Record<string, unknown>>): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  })
}

function token(): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  })).toString('base64url')
  return `header.${payload}.signature`
}

function usage() {
  return {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 2,
  }
}
