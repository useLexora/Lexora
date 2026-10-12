import { readFileSync } from 'node:fs'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { OpenAiCompatibleModelDiscovery } from '../ProviderModelDiscovery'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { ProviderService } from '../ProviderService'

const connection = { id: 'fixture-cpa', displayName: 'CPA fixture', api: 'openai-completions' as const, baseUrl: 'https://fixture.test/v1' }
const directoryModel = {
  slug: 'opaque-alias-high',
  display_name: 'Gemini Flash',
  context_window: 1_048_576,
  max_tokens: 65_536,
  input_modalities: ['text', 'image'],
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'ultra' }],
  base_instructions: 'untrusted-service-instructions',
}
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(connection.id, async () => ({ type: 'api_key', key: 'fixture-key' }))
  let body: unknown = { models: [directoryModel] }
  let status = 200
  let gate: Promise<void> | undefined
  const discovery = new OpenAiCompatibleModelDiscovery({
    credentials,
    request: async () => {
      await gate
      return Response.json(body, { status })
    },
  })
  const repository = createProviderRepository(database)
  const setup = async () => {
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const snapshot: { data: unknown } = JSON.parse(readFileSync(new URL('../data/models-dev.json', import.meta.url), 'utf8'))
    const modelSnapshot = new ProviderModelSnapshotService({ fetch: async () => Response.json(snapshot.data) })
    const service = new ProviderService({ modelSnapshot, authInteractions: new AuthInteractionService(), credentialStatus: createProviderCredentialStatus(credentials), modelDiscovery: discovery, modelRuntime: runtime, providers: repository })
    cleanups.push(() => service.dispose())
    await service.initializeProviders()
    return { service, runtime }
  }
  const first = await setup()
  await first.service.createCustomProvider(connection)
  return {
    ...first,
    setup,
    repository,
    setBody: (value: unknown) => {
      body = value
    },
    setStatus: (value: number) => {
      status = value
    },
    setGate: (value: Promise<void>) => {
      gate = value
    },
  }
}

describe('service model metadata', () => {
  it('retains opaque request IDs, service limits and sparse overrides across sync, refresh and runtime restart', async () => {
    const f = await fixture()
    const initial = (await f.service.syncModels(connection.id))[0]!
    expect(initial).toMatchObject({ id: directoryModel.slug, displayName: directoryModel.display_name, metadataKnown: true, catalogMatch: 'unmatched', contextWindow: 1_048_576, maxTokens: 65_536, capabilities: ['text', 'image', 'reasoning'], reasoningOptions: ['low', 'medium', 'high'] })
    expect(JSON.stringify(f.repository.models.find(connection.id, directoryModel.slug))).not.toContain('untrusted-service-instructions')
    await f.service.setModelEnabled(connection.id, directoryModel.slug, true)
    await f.service.setProviderEnabled(connection.id, true)
    await f.service.setDefaultModel({ providerId: connection.id, modelId: directoryModel.slug, reasoning: 'high' })
    await f.service.setModelCapabilities(connection.id, directoryModel.slug, { image: false })
    await f.service.setModelParametersOverride(connection.id, directoryModel.slug, { contextWindow: 64_000, maxTokens: 8_000 })
    await f.service.syncModels(connection.id)
    await f.service.refreshModelSnapshot()
    await f.service.dispose()
    const { service, runtime } = await f.setup()
    const selection = { providerId: connection.id, modelId: directoryModel.slug, contextWindow: null, maxTokens: null }
    const resolved = service.executionModels.resolve(selection)
    expect(resolved).toMatchObject({ id: directoryModel.slug, api: connection.api, baseUrl: connection.baseUrl, contextWindow: 64_000, maxTokens: 8_000, input: ['text'], reasoning: true })
    expect((await service.listModels(connection.id))[0]).toMatchObject({ enabled: true, sourceContextWindow: 1_048_576, sourceMaxTokens: 65_536, capabilityOverrides: { image: false } })
    expect(await service.getDefaultModel()).toMatchObject({ modelId: directoryModel.slug, reasoning: 'high' })
    let payload: unknown
    let requestUrl = ''
    const result = await runtime.completeSimple(resolved, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, {
      apiKey: 'fixture-key',
      maxRetries: 0,
      fetch: async (url, init) => {
        requestUrl = String(url)
        payload = JSON.parse(String(init?.body))
        return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'accepted' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    expect(result.stopReason, result.errorMessage).toBe('stop')
    expect(requestUrl).toBe('https://fixture.test/v1/chat/completions')
    expect(payload).toMatchObject({ model: directoryModel.slug })
  })

  it('keeps the original catalog match while applying narrower service declarations and user overrides', async () => {
    const f = await fixture()
    const slug = 'gemini-3.8-flash'
    f.setBody({ models: [{ ...directoryModel, slug, input_modalities: ['text'], supported_reasoning_levels: [], context_window: 64_000, max_tokens: 8_000 }] })
    const model = (await f.service.syncModels(connection.id))[0]!
    expect(model).toMatchObject({ id: slug, catalogMatch: 'matched', capabilities: ['text'], reasoningOptions: [], contextWindow: 64_000, maxTokens: 8_000, catalog: { source: { providerId: 'google', modelId: slug } } })
    await f.service.setModelCapabilities(connection.id, slug, { image: true, reasoningOptions: ['high'] })
    await f.service.refreshModelSnapshot()
    expect((await f.service.listModels(connection.id))[0]).toMatchObject({ capabilities: ['text', 'image', 'reasoning'], contextWindow: 64_000, maxTokens: 8_000 })
    await f.service.setModelCapabilities(connection.id, slug, null)
    expect((await f.service.listModels(connection.id))[0]?.capabilities).toEqual(['text'])
    f.setBody({ data: [{ id: slug }] })
    await f.service.syncModels(connection.id)
    expect((await f.service.listModels(connection.id))[0]).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536, catalog: { source: { providerId: 'google', modelId: slug } } })
  })

  it.each(['http', 'malformed', 'duplicate'])('keeps the last successful model states after a %s discovery failure', async (failure) => {
    const f = await fixture()
    await f.service.syncModels(connection.id)
    await f.service.setModelEnabled(connection.id, directoryModel.slug, true)
    const previous = await f.service.listModels(connection.id)
    if (failure === 'http')
      f.setStatus(502)
    else if (failure === 'duplicate')
      f.setBody({ models: [directoryModel, directoryModel] })
    else f.setBody({ models: [{ ...directoryModel, context_window: -1 }] })
    await expect(f.service.syncModels(connection.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(await f.service.listModels(connection.id)).toEqual(previous)
  })

  it.each([
    { baseUrl: 'https://other.test/v1' },
    { baseUrl: 'https://fixture.test/v2' },
    { api: 'openai-responses' as const },
  ])('invalidates service declarations when the connection changes: %j', async (change) => {
    const f = await fixture()
    await f.service.syncModels(connection.id)
    await f.service.setModelEnabled(connection.id, directoryModel.slug, true)
    await f.service.setModelParametersOverride(connection.id, directoryModel.slug, { contextWindow: 32_000, maxTokens: 4_000 })
    await f.service.upsertCustomProvider({ ...connection, ...change })
    expect(f.repository.models.find(connection.id, directoryModel.slug)?.serviceMetadata).toBeNull()
    expect((await f.service.listModels(connection.id))[0]).toMatchObject({ id: directoryModel.slug, enabled: true, metadataKnown: false, sourceContextWindow: 128_000, sourceMaxTokens: 16_384, contextWindow: 32_000, maxTokens: 4_000, capabilities: ['text'] })
  })

  it('rejects a discovery response from the previous connection', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<void>()
    f.setGate(gate.promise)
    const pending = f.service.syncModels(connection.id)
    await f.service.upsertCustomProvider({ ...connection, baseUrl: 'https://updated.test/v1' })
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(await f.service.listModels(connection.id)).toEqual([])
  })
})
