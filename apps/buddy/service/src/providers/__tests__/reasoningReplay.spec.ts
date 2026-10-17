import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding'
import { describe, expect, it } from 'vitest'
import { createBuiltinProviderInstance } from '../createBuiltinProviderInstance'

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

async function requestMessages(messages: Context['messages'], reasoning = false, target = model, request: typeof stream = stream) {
  let payload: { messages: Array<Record<string, unknown>> } | undefined
  const result = await request({ ...target, reasoning }, normalizeContext({ messages, tools: [] }), {
    apiKey: 'fixture-key',
    maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body))
      const chunk = { id: 'fixture-response', choices: [{ index: 0, delta: { role: 'assistant', content: 'Accepted' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  }).result()
  expect(result.stopReason, result.errorMessage).toBe('stop')
  expect(result.provider).toBe(target.provider)
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

  it.each([
    { label: 'different provider', changes: { provider: 'other-service' } },
    { label: 'different API', changes: { api: 'anthropic-messages' as const } },
    { label: 'different model', changes: { model: 'other-model' } },
  ])('replays $label without leaking another model\'s thinking into visible text', async ({ changes }) => {
    const history: Context['messages'] = [
      { ...assistant([
        { type: 'thinking', thinking: 'private-reasoning-marker', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'Visible answer' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' }, thoughtSignature: 'provider-specific-signature' },
      ]), ...changes },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'Result retained' }], isError: false, timestamp: 2 },
    ]
    const original = structuredClone(history)
    const messages = await requestMessages(history)
    expect(messages.find(message => message.role === 'assistant')).toMatchObject({ content: 'Visible answer' })
    expect(messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'read-1', content: 'Result retained' })
    expect(messages.find(message => message.role === 'assistant')?.reasoning_content).toBeUndefined()
    expect(history).toEqual(original)
  })

  it('keeps native service instances distinct while mapping their own history back to the source provider', async () => {
    const source = kimiCodingProvider()
    const instance = createBuiltinProviderInstance({ id: 'kimi-account-a', name: 'Kimi A', source, getCatalogModels: () => source.getModels() })
    const target = instance.getModels().find(model => model.id === 'kimi-for-coding')! as Model<'openai-completions'>
    const histories = [source.id, 'kimi-account-b', instance.id].map((provider, index) => ({
      ...assistant([
        { type: 'thinking' as const, thinking: `reasoning-${provider}`, thinkingSignature: 'reasoning_content' },
        { type: 'text' as const, text: `answer-${index}` },
      ]),
      provider,
      api: target.api,
      model: target.id,
    }))
    const original = structuredClone(histories)
    const messages = await requestMessages(histories, true, target, instance.stream)
    expect(messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content)).toEqual(['', '', 'reasoning-kimi-account-a'])
    expect(JSON.stringify(messages)).not.toContain('reasoning-kimi-coding')
    expect(JSON.stringify(messages)).not.toContain('reasoning-kimi-account-b')
    expect(histories).toEqual(original)
  })

  it('replays Kimi Anthropic-era history through its current Chat Completions API without stale signatures', async () => {
    const provider = kimiCodingProvider()
    const target = provider.getModels().find(model => model.id === 'kimi-for-coding')! as Model<'openai-completions'>
    expect(target.api).toBe('openai-completions')
    const history: Context['messages'] = [
      { ...assistant([
        { type: 'thinking', thinking: 'legacy-kimi-thought', thinkingSignature: 'legacy-anthropic-signature' },
        { type: 'text', text: 'Checking the file' },
        { type: 'toolCall', id: 'toolu_legacy', name: 'read', arguments: { path: 'fixture.txt' } },
      ]), provider: target.provider, model: target.id, api: 'anthropic-messages', stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'toolu_legacy', toolName: 'read', content: [{ type: 'text', text: 'Legacy result' }], isError: false, timestamp: 2 },
    ]
    const original = structuredClone(history)
    const messages = await requestMessages(history, true, target, provider.stream)
    expect(messages.find(message => message.role === 'assistant')).toMatchObject({
      content: 'Checking the file',
      reasoning_content: '',
      tool_calls: [{ id: 'toolu_legacy', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }],
    })
    expect(messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'toolu_legacy', content: 'Legacy result' })
    expect(JSON.stringify(messages)).not.toMatch(/legacy-kimi-thought|legacy-anthropic-signature/)
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
