import type { Context } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InputModel } from '../../../providers/modelCapabilities'
import { Buffer } from 'node:buffer'
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createReusableBuddySession } from '../../sessions/createReusableBuddySession'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../BuddyInputReference'
import { buildBuddyRequestContext } from '../buildBuddyRequestContext'

const model: InputModel = {
  api: 'openai-completions',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  provider: 'fixture',
  id: 'mimo-v2.5',
  name: 'Fixture',
  contextWindow: 128_000,
  maxTokens: 8192,
  input: ['text', 'image'],
  reasoning: false,
  audioInput: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const file = { mimeType: 'audio/wav' as const, name: 'private-fixture.wav', data: Buffer.from('offline-audio-bytes').toString('base64') }
const tools = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' as const, properties: {} } }]

describe('native attachment request guidance', () => {
  it('sends audio with guidance and keeps tools available across follow-ups and model switches', async () => {
    const captured: Array<{ context: Context, payload: unknown }> = []
    const session = {
      model,
      agent: {
        convertToLlm: async (messages: AgentSession['messages']) => messages,
        streamFunction: ((target, context, options) => streamSimple(target, context, {
          ...options,
          apiKey: 'offline-only',
          ...(target.api === 'google-generative-ai' ? {} : { fetch: async () => { throw new Error('Unexpected network request') } }),
          onPayload: async (payload, target) => {
            captured.push({ context, payload: await options?.onPayload?.(payload, target) ?? payload })
            throw new Error('OFFLINE_CAPTURED')
          },
        })) satisfies AgentSession['agent']['streamFunction'],
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
      materializeDocuments: async input => input.documents?.map(() => file) ?? [],
    })
    const input = createBuddyInputReferenceMessage(createBuddyInputReference({
      messageId: 'audio-1',
      prompt: '[FILE#1] private-fixture.wav (AUDIO)\n声音内容是？',
      images: [],
      documents: [{ attachmentId: 'audio-1', mimeType: file.mimeType }],
    }), 1)
    const history: AgentSession['messages'] = [...normalizeContext({ systemPrompt: 'Buddy base prompt', tools, messages: [] }).messages, input]
    const original = structuredClone(input)
    const send = async (target: InputModel) => {
      Object.defineProperty(session, 'model', { configurable: true, value: target })
      const context = { messages: await session.agent.convertToLlm(buildBuddyRequestContext({ messages: convertToLlm(history) }, []).messages) }
      const result = await (await session.agent.streamFunction(target, normalizeContext(context))).result()
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).toContain('Buddy base prompt')
      return result
    }
    expect((await send(model)).errorMessage).toBe('OFFLINE_CAPTURED')
    history.push({ role: 'user', content: '再说一遍', timestamp: 2 })
    expect((await send(model)).errorMessage).toBe('OFFLINE_CAPTURED')
    expect((await send({ ...model, api: 'google-generative-ai', id: 'gemini-2.5-flash', baseUrl: 'https://example.test' })).errorMessage).toBe('OFFLINE_CAPTURED')
    expect(captured).toHaveLength(3)
    for (const { context, payload } of captured) {
      expect(getCurrentSystemPrompt(normalizeContext(context).messages).match(/Attachment resources:/g)).toHaveLength(1)
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).toContain('For native audio, listen')
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).toContain('Do not call read, run playback')
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).toContain('the supplied native snapshot does not represent those edits')
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).toContain('they are not paths')
      expect(getCurrentSystemPrompt(normalizeContext(context).messages)).not.toContain(file.name)
      expect(getCurrentTools(context.messages)).toEqual(tools)
      expect(JSON.stringify(payload)).toContain(file.data)
      expect(JSON.stringify(payload)).not.toContain('buddy-file:')
    }
    expect(captured[0]?.payload).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.arrayContaining([
        { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${file.data}` } },
      ]) }),
    ]) })
    expect(captured[2]?.payload).toMatchObject({ contents: expect.arrayContaining([
      expect.objectContaining({ parts: expect.arrayContaining([{ inlineData: { mimeType: 'audio/wav', data: file.data } }]) }),
    ]) })
    const binaryHistory = {
      role: 'toolResult' as const,
      toolName: 'read',
      toolCallId: 'old-read',
      timestamp: 4,
      isError: false,
      content: [{ type: 'text' as const, text: `RIFF\0\0\0\0WAVE${'\0'.repeat(40_782)}` }],
    }
    history.push({
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: 3,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'old-read', name: 'read', arguments: { path: '/workspace/fixture.wav' } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }, binaryHistory)
    expect((await send(model)).errorMessage).toBe('OFFLINE_CAPTURED')
    const repairedPayload = JSON.stringify(captured.at(-1)?.payload)
    expect(repairedPayload).toContain(file.data)
    expect(repairedPayload).toContain('does not play audio or video')
    expect(repairedPayload).not.toContain('\\u0000')
    expect(binaryHistory.content[0]?.text).toHaveLength(40_794)
    expect((await send({ ...model, audioInput: false })).errorMessage).toBe('OFFLINE_CAPTURED')
    expect(captured).toHaveLength(5)
    expect(JSON.stringify(captured.at(-1)?.payload)).not.toContain(file.data)
    expect(input).toEqual(original)
  })

  it('does not mistake text markers for attachment references', () => {
    const context = normalizeContext({ messages: [{ role: 'user', content: '[FILE#1] example.wav (AUDIO)', timestamp: 0 }] })
    expect(buildBuddyRequestContext(context, [])).toEqual(context)
  })
})
