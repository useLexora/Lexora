import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InputModel } from '../../../providers/modelCapabilities'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai'
import { streamSimple as streamProvider } from '@earendil-works/pi-ai/compat'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createReusableBuddySession } from '../../sessions/createReusableBuddySession'
import { createBuddyInputReference, createBuddyInputReferenceMessage, readBuddyInputReference } from '../BuddyInputReference'
import { prepareBuddyInputHistory } from '../prepareBuddyInputHistory'

describe('oversized input recovery', () => {
  it('can send the next text request after a rejected attachment without repeating the oversized payload', async () => {
    const captured: unknown[] = []
    const model: InputModel = { api: 'google-generative-ai', baseUrl: 'https://example.test', provider: 'fixture', id: 'gemini-2.5-pro', name: 'Fixture', contextWindow: 1_000_000, maxTokens: 8192, input: ['text'], reasoning: false, audioInput: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const transport: AgentSession['agent']['streamFunction'] = (target, context, options) => streamSimple({ ...target, api: 'google-generative-ai', compat: undefined }, context, {
      ...options,
      apiKey: 'offline-fixture',
      onPayload: async (payload, target) => {
        const adapted = await options?.onPayload?.(payload, target)
        captured.push(adapted ?? payload)
        throw new Error('OFFLINE_PAYLOAD_ACCEPTED')
      },
    })
    const session = {
      model,
      agent: {
        convertToLlm: async (messages: AgentSession['messages']) => messages,
        streamFunction: transport,
      },
      getAllTools: () => [],
    } as unknown as AgentSession
    createReusableBuddySession({
      session,
      assertModelAccess: async () => model,
      inputReferences: { pending: null },
      runContext: { current: null },
      shutdown: async () => {},
      materializeInput: async input => [{ type: 'text', text: input.prompt }],
      materializeDocuments: async input => input.documents!.map(file => ({ mimeType: file.mimeType, name: 'audio.wav', data: 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4) })),
    })
    const request = async (messages: AgentSession['messages']) => {
      const converted = await session.agent.convertToLlm(messages)
      return (await session.agent.streamFunction(model, normalizeContext({ messages: converted }))).result()
    }
    const first = reference('first')
    const second = reference('second')
    expect((await request([first])).errorMessage).toBe('OFFLINE_PAYLOAD_ACCEPTED')
    const history = [first, answer(), second]
    const failure = await request(history)
    expect(failure.errorMessage).toBe('MODEL_INPUT_TOO_LARGE')
    expect(captured).toHaveLength(1)
    expect((await request([...history, failure, { role: 'user', content: 'Continue', timestamp: 1 }])).errorMessage).toBe('OFFLINE_PAYLOAD_ACCEPTED')
    expect(captured).toHaveLength(2)
    const resumed = captured[1] as { contents: Array<{ parts: Array<{ inlineData?: unknown }> }> }
    expect(resumed.contents.flatMap(message => message.parts).filter(part => part.inlineData)).toHaveLength(1)
    expect(readBuddyInputReference(second)?.documents).toHaveLength(1)
  })

  it('preserves an attachment that fits beside a transcript system message', async () => {
    const model: InputModel = { api: 'google-generative-ai', baseUrl: 'https://example.test', provider: 'fixture', id: 'gemini-2.5-pro', name: 'Fixture', contextWindow: 1_000_000, maxTokens: 8192, input: ['text', 'image'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const system = { role: 'system' as const, content: 's'.repeat(10_000), timestamp: 1 }
    const session = {
      model,
      systemPrompt: system.content,
      agent: { convertToLlm: async (messages: AgentSession['messages']) => messages },
    } as AgentSession
    const projected: string[][] = []
    createReusableBuddySession({
      session,
      assertModelAccess: async () => model,
      inputReferences: { pending: null },
      runContext: { current: null },
      shutdown: async () => {},
      getInputMetadata: () => [{ id: 'image-1', sizeBytes: 1_000 }],
      materializeInput: async (input) => {
        projected.push(input.images.map(image => image.attachmentId))
        return input.prompt
      },
    })
    const input = createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: 'input', prompt: 'Inspect', images: [{ attachmentId: 'image-1', mimeType: 'image/png' }] }), 3)
    const user = { role: 'user' as const, content: 'u'.repeat(18_935_000), timestamp: 2 }
    await session.agent.convertToLlm([system, user, input])
    expect(projected).toEqual([['image-1']])
    await session.agent.convertToLlm([system, { ...user, content: `${user.content}${'x'.repeat(20_000)}` }, input])
    expect(projected).toEqual([['image-1'], []])
  })

  it('retains attachments that were delivered before a later local failure', () => {
    const accepted = reference('accepted')
    const steering = reference('steering')
    const history = [accepted, answer(), steering, answer('MODEL_INPUT_TOO_LARGE')]
    const result = prepareBuddyInputHistory(history)
    expect(readBuddyInputReference(result[0])?.documents).toEqual(accepted.buddyInput.documents)
    expect(readBuddyInputReference(result[2])).toBeNull()
    expect(result[2]).toMatchObject({ role: 'user', content: expect.stringContaining('MODEL_INPUT_TOO_LARGE') })
    expect(history[2]).toBe(steering)
    expect(readBuddyInputReference(steering)?.documents).toHaveLength(1)
  })

  it('budgets prepared images instead of originals and prefers recent input to old tool images', async () => {
    const model: InputModel = { api: 'openai-completions', baseUrl: 'https://example.test', provider: 'fixture', id: 'vision', name: 'Fixture', contextWindow: 128_000, maxTokens: 1024, input: ['text', 'image'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, inputLimits: { maxRequestBytes: 10_000, images: { maxPerRequest: 1, maxPerMessage: 1 } } }
    const session = { model, agent: { convertToLlm: async (messages: AgentSession['messages']) => messages } } as AgentSession
    const projected: string[][] = []
    createReusableBuddySession({
      session,
      assertModelAccess: async () => model,
      inputReferences: { pending: null },
      runContext: { current: null },
      shutdown: async () => {},
      getInputMetadata: ids => ids.map(id => ({ id, sizeBytes: 20 * 1024 * 1024 })),
      prepareInputImages: async images => new Map(images.map(image => [image.attachmentId, { image: { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' } }])),
      materializeInput: async (input, images) => {
        projected.push(input.images.map(image => image.attachmentId))
        return [{ type: 'text', text: input.prompt }, ...input.images.map(image => images!.get(image.attachmentId)!.image)]
      },
    })
    const reference = (id: string) => createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: id, prompt: 'Inspect', images: [{ attachmentId: 'shared-image', mimeType: 'image/png' }] }), 0)
    const tool = { role: 'toolResult' as const, toolCallId: 'read', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }] }
    const original = [reference('old'), tool, reference('new')]
    const before = JSON.stringify(original)
    const converted = await session.agent.convertToLlm(original)
    expect(projected).toEqual([[], ['shared-image']])
    expect(converted[1]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('not supplied') }] })
    expect(converted[2]).toMatchObject({ content: [{ type: 'text' }, { type: 'image', data: 'AAAA' }] })
    expect(JSON.stringify(original)).toBe(before)
  })

  it('keeps the existing retry behavior for missing resources and upstream errors', () => {
    for (const code of ['RESOURCE_MATERIALIZATION_FAILED', 'MODEL_INPUT_UNSUPPORTED', 'upstream unavailable']) {
      const input = reference('input')
      expect(prepareBuddyInputHistory([input, answer(code)])[0]).toBe(input)
    }
  })

  it.each([
    { api: 'openai-completions', imageKey: '"type":"image_url"', counts: [16] },
    { api: 'anthropic-messages', imageKey: '"type":"image"', counts: [16] },
    { api: 'bedrock-converse-stream', imageKey: '"image":', counts: [16] },
    { api: 'openai-responses', imageKey: '"type":"input_image"', counts: [10, 10] },
  ])('budgets tool images after $api message merging across continuations and follow-ups', async ({ api, imageKey, counts }) => {
    const model: InputModel = { api, baseUrl: 'https://example.test', provider: 'fixture', id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 1024, input: ['text', 'image'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const payloads: Array<{ messages?: unknown[], input?: unknown[] }> = []
    const session = {
      model,
      agent: {
        convertToLlm: async (messages: AgentSession['messages']) => convertToLlm(messages),
        streamFunction: ((target, context, options) => streamProvider(target, context, {
          ...options,
          apiKey: 'offline-fixture',
          fetch: async () => { throw new Error('Unexpected network request') },
          onPayload: async (payload, target) => {
            const checked = await options?.onPayload?.(payload, target) ?? payload
            payloads.push(checked as typeof payloads[number])
            throw new Error('OFFLINE_PAYLOAD_ACCEPTED')
          },
        })) satisfies AgentSession['agent']['streamFunction'],
      },
    } as unknown as AgentSession
    createReusableBuddySession({
      session,
      assertModelAccess: async () => model,
      inputReferences: { pending: null },
      runContext: { current: null },
      shutdown: async () => {},
      materializeInput: async input => [{ type: 'text', text: input.prompt }],
    })
    const round = (id: string): AgentSession['messages'] => [
      {
        ...answer(),
        api,
        stopReason: 'toolUse',
        content: [0, 1, 2].map(index => ({ type: 'toolCall', id: `${id}-${index}`, name: 'read', arguments: { path: '/workspace/image.png' } })),
      },
      ...[10, 0, 10].map((count, index) => ({
        role: 'toolResult' as const,
        toolCallId: `${id}-${index}`,
        toolName: 'read',
        timestamp: 0,
        isError: false,
        content: [{ type: 'text' as const, text: 'Working file: /workspace/image.png' }, ...Array.from({ length: count }, () => ({ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }))],
      })),
    ]
    const history: AgentSession['messages'] = [{ role: 'user', content: 'Inspect the files', timestamp: 0 }, ...round('first')]
    const send = async () => {
      const before = structuredClone(history)
      const messages = await session.agent.convertToLlm(history)
      const result = await (await session.agent.streamFunction(model, normalizeContext({ messages }))).result()
      expect(result.errorMessage).toBe('OFFLINE_PAYLOAD_ACCEPTED')
      expect(history).toEqual(before)
      return messages
    }
    const projected = await send()
    expect(projected.filter(message => message.role === 'toolResult').map(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image').length : 0))
      .toEqual(api === 'openai-responses' ? [10, 0, 10] : [6, 0, 10])
    history.push({ ...answer(), api }, { role: 'user', content: 'Continue with the same files', timestamp: 1 })
    await send()
    history.push(...round('second'))
    await send()
    expect(payloads.map(payload => (payload.messages ?? payload.input ?? []).map(message => JSON.stringify(message).split(imageKey).length - 1).filter(count => count > 0)))
      .toEqual([counts, counts, [...counts, ...counts]])
  })
})

function reference(messageId: string) {
  return createBuddyInputReferenceMessage(createBuddyInputReference({ messageId, prompt: `Inspect ${messageId}.wav`, images: [], documents: [{ attachmentId: messageId, mimeType: 'audio/wav' }] }), 0)
}

function answer(errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: 'google-generative-ai', provider: 'fixture', model: 'fixture', content: errorMessage ? [] : [{ type: 'text', text: 'Accepted' }], stopReason: errorMessage ? 'error' : 'stop', errorMessage, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
