import type { Api, AssistantMessage, Context, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { createProviderModelRuntime } from '../../../service/src/providers/createProviderModelRuntime'
import { ProviderRequestHeaders } from '../../../service/src/providers/ProviderRequestHeaders'

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const model: Model<Api> = { id: 'local-text', provider: 'fixture-local-plugin', name: 'Local fixture', api: 'fixture-native', baseUrl: '', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 256, cost }

async function fixture(api: ProviderStreams) {
  const credentials = new InMemoryCredentialStore()
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  const registration = createProviderModelRuntime(runtime, new ProviderRequestHeaders({ getRequestHeaders: () => [] } as never))
  registration.registerNativeProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: 'Local runtime', resolve: async () => ({ auth: {}, source: 'plugin runtime' }) } },
    models: [model],
    api,
  }))
  await registration.refresh({ allowNetwork: false })
  return { credentials, runtime, registration }
}

function response(target: Model<Api>): AssistantMessage {
  return { role: 'assistant', content: [], api: target.api, provider: target.provider, model: target.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { ...cost, total: 0 } } }
}

it('runs keyless native models with original context, tool events and usage through the provider wrapper', async () => {
  let received: unknown
  const stream: ProviderStreams['streamSimple'] = (target, context) => {
    received = context
    const events = createAssistantMessageEventStream()
    const message = response(target)
    queueMicrotask(() => {
      events.push({ type: 'start', partial: message })
      message.content.push({ type: 'text', text: 'Local answer' })
      events.push({ type: 'text_start', contentIndex: 0, partial: message })
      events.push({ type: 'text_delta', contentIndex: 0, delta: 'Local answer', partial: message })
      events.push({ type: 'text_end', contentIndex: 0, content: 'Local answer', partial: message })
      const toolCall = { type: 'toolCall' as const, id: 'local-call', name: 'fixture_tool', arguments: { value: 'kept' } }
      message.content.push(toolCall)
      events.push({ type: 'toolcall_start', contentIndex: 1, partial: message })
      events.push({ type: 'toolcall_end', contentIndex: 1, toolCall, partial: message })
      message.stopReason = 'toolUse'
      events.push({ type: 'done', reason: 'toolUse', message })
    })
    return events
  }
  const f = await fixture({ stream, streamSimple: stream })
  const context: Context = { systemPrompt: 'System fixture', messages: [{ role: 'user', content: 'Original task input', timestamp: 1 }], tools: [{ name: 'fixture_tool', description: 'Fixture', parameters: { type: 'object', properties: {} } }] }
  expect(await f.runtime.getAvailable(model.provider)).toHaveLength(1)
  expect(await f.credentials.list()).toEqual([])
  const events = f.runtime.streamSimple(model, context)
  const types = []
  for await (const event of events) types.push(event.type)
  expect(types).toContain('text_delta')
  expect(types).toContain('toolcall_end')
  expect(await events.result()).toMatchObject({ provider: model.provider, model: model.id, stopReason: 'toolUse', usage: { totalTokens: 9 }, content: [{ type: 'text', text: 'Local answer' }, { type: 'toolCall', arguments: { value: 'kept' } }] })
  expect(received).toMatchObject({ messages: [
    { role: 'system', content: context.systemPrompt, toolsAdded: context.tools },
    { role: 'user', content: 'Original task input', timestamp: 1 },
  ] })
  f.registration.unregisterProvider(model.provider)
  await f.registration.refresh({ allowNetwork: false })
  expect(f.runtime.getModels(model.provider)).toEqual([])
})

it('propagates cancellation without a fabricated key or replacement model', async () => {
  const ready = Promise.withResolvers<void>()
  const stream: ProviderStreams['streamSimple'] = (target, _context, options) => {
    const events = createAssistantMessageEventStream()
    const message = response(target)
    const abort = () => {
      message.stopReason = 'aborted'
      events.push({ type: 'error', reason: 'aborted', error: message })
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted)
      abort()
    ready.resolve()
    return events
  }
  const f = await fixture({ stream, streamSimple: stream })
  const controller = new AbortController()
  const result = f.runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Cancel fixture', timestamp: 1 }] }, { signal: controller.signal })
  await ready.promise
  controller.abort()
  expect(await result).toMatchObject({ stopReason: 'aborted', provider: model.provider, model: model.id })
  expect(await f.credentials.list()).toEqual([])
})
