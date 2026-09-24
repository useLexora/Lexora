import { getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { readModelCapabilities } from '../modelCapabilities'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'
import { ProviderService } from '../ProviderService'
import { INFERRED_STREAM_COMPLETION } from '../withProviderStream'

describe('provider model resolution', () => {
  it.each([
    { name: 'text followed by DONE without a finish reason', delta: { content: 'accepted' }, finishReason: null, done: true, stopReason: 'stop' },
    { name: 'text followed by EOF without a finish reason', delta: { content: 'partial' }, finishReason: null, done: false, stopReason: 'error' },
    { name: 'empty stream', delta: {}, finishReason: null, done: true, stopReason: 'error' },
    { name: 'whitespace only', delta: { content: '  \n' }, finishReason: null, done: true, stopReason: 'error' },
    { name: 'reasoning only', delta: { reasoning_content: 'thinking' }, finishReason: null, done: true, stopReason: 'error' },
    { name: 'incomplete tool arguments', delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finishReason: null, done: false, stopReason: 'error' },
    { name: 'incomplete tool arguments with DONE', delta: { content: 'reading', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finishReason: null, done: true, stopReason: 'error' },
    { name: 'parseable tool arguments without a finish reason', delta: { content: 'reading', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"example.txt"}' } }] }, finishReason: null, done: true, stopReason: 'error' },
    { name: 'completed text', delta: { content: 'complete' }, finishReason: 'stop', done: true, stopReason: 'stop' },
    { name: 'length limit', delta: { content: 'partial' }, finishReason: 'length', done: true, stopReason: 'length' },
    { name: 'finish reason without DONE', delta: { content: 'complete' }, finishReason: 'stop', done: false, stopReason: 'stop' },
    { name: 'completed tool call', delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"example.txt"}' } }] }, finishReason: 'tool_calls', done: true, stopReason: 'toolUse' },
  ])('handles custom provider stream completion: $name', async ({ delta, finishReason, done, stopReason }) => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const credentials = new InMemoryCredentialStore()
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const providers = createProviderRepository(database)
      const service = new ProviderService({
        authInteractions: new AuthInteractionService({ notify: () => {} }),
        credentialStatus: createProviderCredentialStatus(credentials),
        modelDiscovery: { supports: () => false, discover: async () => [] },
        modelRuntime: createProviderModelRuntime(runtime, new ProviderRequestHeaders(providers.states)),
        providers,
      })
      await service.upsertCustomProvider({
        api: 'openai-completions',
        baseUrl: 'https://relay.example.test/v1',
        displayName: 'Fixture relay',
        id: 'fixture-relay',
        models: [{ id: 'relay-model' }],
      })
      const model = service.executionModels.resolve({ providerId: 'fixture-relay', modelId: 'relay-model', contextWindow: null, maxTokens: null })
      const chunk = { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finishReason }] }
      const options = {
        apiKey: 'fixture-key',
        maxRetries: 0,
        fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\n${done ? 'data: [DONE]\n\n' : ''}`, { headers: { 'content-type': 'text/event-stream' } }),
      }
      for (const simple of [false, true]) {
        const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 1 }] }
        const result = await (simple ? runtime.completeSimple(model, context, options) : runtime.complete(model, context, options))
        expect(result.stopReason, result.errorMessage).toBe(stopReason)
        if (stopReason === 'error')
          expect(result.errorMessage).toContain('Stream ended without finish_reason')
        else
          expect(result.errorMessage).toBeUndefined()
        expect(result.diagnostics?.some(item => item.type === INFERRED_STREAM_COMPLETION) ?? false).toBe(!finishReason && stopReason === 'stop')
      }
    }
    finally {
      database.close()
    }
  })

  it('uses the current connection for list and execution while retaining imported model edits across restart', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const credentials = new InMemoryCredentialStore()
    const providers = createProviderRepository(database)
    const setup = async () => {
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const service = new ProviderService({
        authInteractions: new AuthInteractionService({ notify: () => {} }),
        credentialStatus: createProviderCredentialStatus(credentials),
        modelDiscovery: { supports: () => false, discover: async () => [] },
        modelRuntime: runtime,
        providers,
      })
      await service.initializeProviders()
      return { service, runtime }
    }
    try {
      const { service } = await setup()
      const connection = { id: 'fixture-relay', displayName: 'Fixture relay', baseUrl: 'https://relay.example.test/v1' }
      await service.upsertCustomProvider({
        ...connection,
        api: 'openai-completions',
        models: [{ id: 'manual-model', name: 'Imported model' }],
      })
      await service.upsertManualModel(connection.id, { id: 'manual-model', name: 'Edited model', contextWindow: 64_000, maxTokens: 8000 })
      await service.setModelParametersOverride(connection.id, 'manual-model', { contextWindow: 32_000, maxTokens: 4000 })
      const capabilities = { image: true, audio: true, video: true, reasoningOptions: ['off', 'high'] as Array<'off' | 'high'> }
      await service.setModelCapabilities(connection.id, 'manual-model', capabilities)
      expect((await service.listModels(connection.id))[0]).toMatchObject({ api: 'openai-completions', capabilities: ['text', 'image', 'audio', 'reasoning'] })

      await service.upsertCustomProvider({ ...connection, api: 'anthropic-messages', baseUrl: 'https://updated.example.test', models: [] })
      const verify = async (service: ProviderService) => {
        const listed = (await service.listModels(connection.id))[0]!
        const resolved = service.executionModels.resolve({ providerId: connection.id, modelId: 'manual-model', contextWindow: null, maxTokens: null })
        expect(listed).toMatchObject({
          api: 'anthropic-messages',
          capabilities: ['text', 'image', 'reasoning'],
          capabilityOverrides: capabilities,
          displayName: 'Edited model',
          contextWindow: 32_000,
          maxTokens: 4000,
          sourceContextWindow: 64_000,
          sourceMaxTokens: 8000,
        })
        expect(resolved).toMatchObject({ api: listed.api, name: listed.displayName, baseUrl: 'https://updated.example.test', contextWindow: listed.contextWindow, maxTokens: listed.maxTokens })
        expect(readModelCapabilities(resolved)).toMatchObject({ image: true, audio: false, video: false })
        expect(getSupportedThinkingLevels(resolved)).toEqual(listed.reasoningOptions)
      }
      await verify(service)
      const restored = await setup()
      await verify(restored.service)
      expect(restored.runtime.getModels(connection.id)).toMatchObject([{ id: 'manual-model', name: 'Edited model', api: 'anthropic-messages', contextWindow: 64_000 }])
    }
    finally {
      database.close()
    }
  })
})
