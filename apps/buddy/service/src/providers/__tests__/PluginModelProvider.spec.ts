import type { ExtensionChatEvent, ExtensionChatRequest, ExtensionModel } from '../../../../shared/extensions/extensionChat'
import { randomUUID } from 'node:crypto'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { pngBytes } from '../../images/__tests__/pluginImageFixtures'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { createPluginProvider } from '../createPluginProvider'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'

const descriptor: ExtensionModel = {
  id: 'local',
  title: 'Local model',
  capability: 'chat',
  contextWindow: 8192,
  maxTokens: 512,
  tools: true,
  extensionId: 'fixture.models',
  extensionName: 'Model fixture',
  generation: randomUUID(),
  revision: 'a'.repeat(64),
  bindingRevision: 'b'.repeat(64),
  managementPage: true,
}
const done: ExtensionChatEvent = { type: 'done', reason: 'stop', usage: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0 } }
const databases: ReturnType<typeof openBuddyDatabase>[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

async function fixture(invoke: Parameters<typeof createPluginProvider>[1], model = descriptor) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const registration = createProviderModelRuntime(runtime, new ProviderRequestHeaders(createProviderRepository(database).states))
  const provider = createPluginProvider([model], invoke)
  registration.registerNativeProvider(provider)
  await registration.refresh({ allowNetwork: false })
  return { runtime, model: runtime.getModels(provider.id)[0]! }
}

describe('plugin model provider', () => {
  it('preserves resolved instructions, current tools, streamed text and actual usage', async () => {
    let request: ExtensionChatRequest | undefined
    const f = await fixture(async (_target, input, _signal, emit) => {
      request = input
      emit({ type: 'text', text: 'Local answer' })
      emit(done)
    })
    const response = await f.runtime.completeSimple(f.model, { messages: [
      { role: 'system', content: 'Original instructions', sections: { task: 'old' }, toolsAdded: [{ name: 'old', description: 'Old tool', parameters: { type: 'object', properties: {} } }], timestamp: 0 },
      { role: 'user', content: 'First turn', timestamp: 1 },
      { role: 'system', content: 'New instructions', sections: { task: 'current' }, toolsRemoved: [{ name: 'old' }], toolsAdded: [{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: { optional: { type: 'string' } } } }], timestamp: 2 },
    ] })
    expect(response).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Local answer' }], usage: { input: 9, output: 3, totalTokens: 12 } })
    expect(request?.messages[0]).toMatchObject({ role: 'system', text: expect.stringContaining('current') })
    expect(request?.messages[0]).toMatchObject({ text: expect.not.stringContaining('old') })
    expect(request?.tools).toEqual([{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: { optional: { type: 'string' } } } }])
  })

  it.each(['medium', undefined] as const)('maps Pi reasoning %s to an explicit backend preference without changing the output budget', async (reasoning) => {
    let request: ExtensionChatRequest | undefined
    const f = await fixture(async (_target, input, _signal, emit) => {
      request = input
      emit({ type: 'text', text: 'A concise title' })
      emit(done)
    }, { ...descriptor, reasoning: true })
    const response = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: 'Name this task.', timestamp: 1 }] }, { maxTokens: 256, ...(reasoning !== undefined ? { reasoning } : {}) })
    expect(response).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'A concise title' }] })
    expect(request).toMatchObject({ maxTokens: 256 })
    expect(request?.reasoning).toBe(reasoning ?? 'off')
  })

  it('streams thinking independently and keeps a short non-thinking request local to that call', async () => {
    const requests: ExtensionChatRequest[] = []
    const f = await fixture(async (_target, input, _signal, emit) => {
      requests.push(input)
      if (input.reasoning !== 'off') {
        emit({ type: 'thinking', text: 'Evaluate ' })
        emit({ type: 'thinking', text: 'the result.' })
      }
      emit({ type: 'text', text: 'Answer' })
      emit(done)
    }, { ...descriptor, reasoning: true })
    const events: string[] = []
    const stream = f.runtime.streamSimple(f.model, { messages: [{ role: 'user', content: 'Handle the task.', timestamp: 0 }] }, { reasoning: 'medium' })
    for await (const event of stream)
      events.push(event.type)
    expect((await stream.result()).content).toEqual([{ type: 'thinking', thinking: 'Evaluate the result.' }, { type: 'text', text: 'Answer' }])
    expect(events).toEqual(['start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done'])
    const title = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: 'Name the task.', timestamp: 1 }] }, { maxTokens: 256 })
    expect(title.content).toEqual([{ type: 'text', text: 'Answer' }])
    expect(requests.map(({ reasoning, maxTokens }) => ({ reasoning, maxTokens }))).toEqual([{ reasoning: 'medium', maxTokens: descriptor.maxTokens }, { reasoning: 'off', maxTokens: 256 }])
    expect(f.model.reasoning).toBe(true)
  })

  it.each([false, true])('rejects unsolicited thinking with an off request (declared: %s)', async (reasoning) => {
    const f = await fixture(async (_target, _input, _signal, emit) => {
      emit({ type: 'thinking', text: 'Unexpected thinking' })
      emit(done)
    }, { ...descriptor, reasoning })
    const response = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: 'Name the task.', timestamp: 0 }] })
    expect(response).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_OUTPUT_INVALID', content: [] })
  })

  it('preserves ordered user and tool images while keeping legacy text and tool declarations unchanged', async () => {
    let request: ExtensionChatRequest | undefined
    const image = { type: 'image', mimeType: 'image/png', data: pngBytes().toString('base64') } as const
    const f = await fixture(async (_target, input, _signal, emit) => {
      request = input
      emit({ type: 'text', text: 'Visible fixture' })
      emit(done)
    }, { ...descriptor, input: ['text', 'image'], tools: false })
    const userContent = [{ type: 'text' as const, text: 'Before' }, image, { type: 'text' as const, text: 'Between' }, image, { type: 'text' as const, text: 'After' }]
    const toolContent = [image, { type: 'text' as const, text: 'Tool description' }]
    const response = await f.runtime.completeSimple(f.model, { messages: [
      { role: 'user', content: 'Legacy user text', timestamp: 0 },
      { role: 'user', content: userContent, timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }], api: f.model.api, provider: f.model.provider, model: f.model.id, stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 },
      { role: 'toolResult', content: toolContent, toolCallId: 'read-1', toolName: 'read', isError: false, timestamp: 3 },
      { role: 'toolResult', content: [{ type: 'text', text: 'Legacy tool text' }], toolCallId: 'read-2', toolName: 'read', isError: false, timestamp: 4 },
    ] })
    expect(response).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Visible fixture' }] })
    expect(request?.messages).toEqual([
      { role: 'user', text: 'Legacy user text' },
      { role: 'user', content: userContent },
      { role: 'assistant', text: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }] },
      { role: 'tool', content: toolContent, toolCallId: 'read-1', name: 'read', isError: false },
      { role: 'tool', text: 'Legacy tool text', toolCallId: 'read-2', name: 'read', isError: false },
    ])
    expect(request?.tools).toEqual([])
    expect(f.model).toMatchObject({ input: ['text', 'image'], toolCall: false })
  })

  it.each(['user', 'toolResult'] as const)('rejects %s images when the effective model does not support image input', async (role) => {
    const requests: ExtensionChatRequest[] = []
    const f = await fixture(async (_target, input, _signal, emit) => {
      requests.push(input)
      emit(done)
    })
    const image = { type: 'image', mimeType: 'image/png', data: pngBytes().toString('base64') } as const
    const response = await f.runtime.completeSimple(f.model, { messages: [
      role === 'user' ? { role, content: [image], timestamp: 0 } : { role, content: [image], toolCallId: 'read', toolName: 'read', isError: false, timestamp: 0 },
    ] })
    expect(response).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_INPUT_UNSUPPORTED', content: [] })
    expect(requests).toEqual([])
    expect(f.model.input).toEqual(['text'])
  })

  it('rejects unsupported image MIME types without discarding the supplied image', async () => {
    const requests: ExtensionChatRequest[] = []
    const f = await fixture(async (_target, input, _signal, emit) => {
      requests.push(input)
      emit(done)
    }, { ...descriptor, input: ['text', 'image'] })
    const response = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/bmp', data: pngBytes().toString('base64') }], timestamp: 0 }] })
    expect(response).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_INPUT_UNSUPPORTED', content: [] })
    expect(requests).toEqual([])
  })

  it.each(['incomplete', 'unknown-tool', 'duplicate-done', 'cancel'] as const)('rejects %s without substituting a model or reporting success', async (failure) => {
    const abort = new AbortController()
    const f = await fixture(async (_target, _input, _signal, emit) => {
      emit({ type: 'text', text: 'partial' })
      if (failure === 'unknown-tool')
        emit({ type: 'tool', call: { id: 'call', name: 'undeclared', arguments: {} } })
      if (failure === 'duplicate-done') {
        emit(done)
        emit(done)
      }
      if (failure === 'cancel')
        abort.abort()
    })
    const response = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: 'Request', timestamp: 1 }] }, { signal: abort.signal })
    expect(response).toMatchObject({ stopReason: failure === 'cancel' ? 'aborted' : 'error', provider: 'plugin:fixture.models', model: 'local' })
    if (failure !== 'cancel')
      expect(response.content).toEqual([{ type: 'text', text: 'partial' }])
  })

  it.each([false, 'auto'] as const)('omits tools and rejects tool output for a disabled or unresolved binding (%s)', async (tools) => {
    let request: ExtensionChatRequest | undefined
    const f = await fixture(async (_target, input, _signal, emit) => {
      request = input
      emit({ type: 'tool', call: { id: 'call', name: 'read', arguments: {} } })
    }, { ...descriptor, tools, input: ['text', 'image'] })
    const response = await f.runtime.completeSimple(f.model, { messages: [{ role: 'user', content: 'Try a tool', timestamp: 1 }], tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] })
    expect(request?.tools).toEqual([])
    expect(f.model).toMatchObject({ toolCall: false })
    expect(response).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_TOOL_INVALID', content: [] })
  })
})
