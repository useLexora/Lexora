import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { describe, expect, it } from 'vitest'

const model: Model<'openai-completions'> = {
  api: 'openai-completions',
  provider: 'fixture-service',
  id: 'fixture-model',
  name: 'Fixture model',
  baseUrl: 'https://fixture.example.test/v1',
  contextWindow: 128_000,
  maxTokens: 4_096,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: 'stop',
    timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...model.cost, total: 0 } },
  }
}

async function requestMessages(messages: Context['messages'], reasoning = false) {
  let payload: { messages: Array<Record<string, unknown>> } | undefined
  const result = await stream({ ...model, reasoning }, normalizeContext({ messages, tools: [] }), {
    apiKey: 'fixture-key',
    maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body))
      const chunk = { id: 'fixture-response', choices: [{ index: 0, delta: { role: 'assistant', content: 'Accepted' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  }).result()
  expect(result.stopReason, result.errorMessage).toBe('stop')
  return payload!.messages
}

describe('reasoning replay over Chat Completions', () => {
  it.each([false, true])('preserves long reasoning and fills earlier and later assistant gaps regardless of model metadata: %s', async (reasoning) => {
    const thinking = `Beginning\n${'Detailed reasoning. '.repeat(5_000)}\nEnd`
    const history: Context['messages'] = [
      { role: 'user', content: 'First question', timestamp: 1 },
      assistant([{ type: 'text', text: 'First answer' }]),
      { role: 'user', content: 'Check the file', timestamp: 2 },
      assistant([
        { type: 'thinking', thinking, thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'example.txt' } },
      ]),
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'File contents' }], isError: false, timestamp: 3 },
      assistant([{ type: 'text', text: 'The file is checked' }]),
      { role: 'user', content: 'Continue', timestamp: 4 },
    ]
    const original = structuredClone(history)
    const messages = await requestMessages(history, reasoning)
    expect(messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content)).toEqual(['', thinking, ''])
    expect(messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'read-1', content: 'File contents' })
    expect(history).toEqual(original)
  })

  it('leaves plain conversations and other reasoning wire fields unchanged', async () => {
    for (const signature of [undefined, 'reasoning', 'reasoning_text']) {
      const content: AssistantMessage['content'] = [{ type: 'text', text: 'Answer' }]
      if (signature)
        content.unshift({ type: 'thinking', thinking: 'A visible thought', thinkingSignature: signature })
      const messages = await requestMessages([
        { role: 'user', content: 'Question', timestamp: 1 },
        assistant(content),
        assistant([{ type: 'text', text: 'Plain follow-up' }]),
      ])
      expect(messages.every(message => !Object.hasOwn(message, 'reasoning_content'))).toBe(true)
      if (signature)
        expect(messages.find(message => message.role === 'assistant')?.[signature]).toBe('A visible thought')
    }
  })
})
