import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InputModel } from '../../../providers/modelCapabilities'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai'
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

  it('keeps the existing retry behavior for missing resources and upstream errors', () => {
    for (const code of ['RESOURCE_MATERIALIZATION_FAILED', 'MODEL_INPUT_UNSUPPORTED', 'upstream unavailable']) {
      const input = reference('input')
      expect(prepareBuddyInputHistory([input, answer(code)])[0]).toBe(input)
    }
  })
})

function reference(messageId: string) {
  return createBuddyInputReferenceMessage(createBuddyInputReference({ messageId, prompt: `Inspect ${messageId}.wav`, images: [], documents: [{ attachmentId: messageId, mimeType: 'audio/wav' }] }), 0)
}

function answer(errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: 'google-generative-ai', provider: 'fixture', model: 'fixture', content: errorMessage ? [] : [{ type: 'text', text: 'Accepted' }], stopReason: errorMessage ? 'error' : 'stop', errorMessage, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
