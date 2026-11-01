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

async function fixture(request?: typeof fetch) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(connection.id, async () => ({ type: 'api_key', key: 'fixture-key' }))
  let body: unknown = { models: [directoryModel] }
  let status = 200
  let gate: Promise<void> | undefined
  let activeRuns: Array<{ provider: string, model: string }> = []
  const discovery = new OpenAiCompatibleModelDiscovery({
    credentials,
    request: request ?? (async () => {
      await gate
      return Response.json(body, { status })
    }),
  })
  const repository = createProviderRepository(database)
  const setup = async () => {
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const snapshot: { data: unknown } = JSON.parse(readFileSync(new URL('../data/models-dev.json', import.meta.url), 'utf8'))
    const modelSnapshot = new ProviderModelSnapshotService({ fetch: async () => Response.json(snapshot.data) })
    const service = new ProviderService({ getActiveRuns: () => activeRuns, modelSnapshot, authInteractions: new AuthInteractionService(), credentialStatus: createProviderCredentialStatus(credentials), modelDiscovery: discovery, modelRuntime: runtime, providers: repository })
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
    setActiveRuns: (value: typeof activeRuns) => {
      activeRuns = value
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

  it.each([
    ['workbuddy/deepseek-v4.1-flash', 'deepseek', 'deepseek-flash'],
    ['gemini-3.8-flash-high', 'google', 'gemini-3.8-flash'],
  ])('recovers %s from standard IDs and preserves its image payload and wire ID after restart', async (id, catalogProviderId, catalogModelId) => {
    const f = await fixture()
    f.setBody({ data: [{ id }] })
    expect((await f.service.syncModels(connection.id))[0]).toMatchObject({ id, sourceCapabilities: { image: true }, catalogMatch: 'matched', catalog: { source: { providerId: catalogProviderId, modelId: catalogModelId } } })
    await f.service.setModelEnabled(connection.id, id, true)
    await f.service.setProviderEnabled(connection.id, true)
    await f.service.setModelCapabilities(connection.id, id, { image: false })
    await f.service.refreshModelSnapshot()
    await f.service.dispose()
    const { service, runtime } = await f.setup()
    expect((await service.listModels(connection.id))[0]).toMatchObject({ id, capabilityOverrides: { image: false }, sourceCapabilities: { image: true } })
    await service.setModelCapabilities(connection.id, id, null)
    const resolved = service.executionModels.resolve({ providerId: connection.id, modelId: id, contextWindow: null, maxTokens: null })
    expect(resolved).toMatchObject({ id, provider: connection.id, api: connection.api, baseUrl: connection.baseUrl, input: ['text', 'image'] })
    let payload: unknown
    const result = await runtime.completeSimple(resolved, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image', data: 'fixture-image', mimeType: 'image/png' }], timestamp: 1 }] }, {
      apiKey: 'fixture-key',
      maxRetries: 0,
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body))
        return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'accepted' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    expect(result.stopReason, result.errorMessage).toBe('stop')
    expect(payload).toMatchObject({ model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture-image' } }] }] })
  })

  it('preserves the inferred catalog match while service declarations and user overrides take precedence across restart', async () => {
    const f = await fixture()
    const id = 'gemini-3.8-flash-high'
    const catalog = { source: { providerId: 'google', modelId: 'gemini-3.8-flash' } }
    f.setBody({ data: [{ id, input_modalities: ['text'], supported_reasoning_levels: [], context_window: 64_000, max_tokens: 8_000 }] })
    const expected = { id, catalogMatch: 'matched', capabilities: ['text'], reasoningOptions: [], contextWindow: 64_000, maxTokens: 8_000, catalog }
    expect((await f.service.syncModels(connection.id))[0]).toMatchObject(expected)
    await f.service.refreshModelSnapshot()
    await f.service.dispose()
    const { service } = await f.setup()
    expect((await service.listModels(connection.id))[0]).toMatchObject(expected)
    await service.setModelCapabilities(connection.id, id, { image: true, reasoningOptions: ['high'] })
    await service.refreshModelSnapshot()
    expect((await service.listModels(connection.id))[0]).toMatchObject({ capabilities: ['text', 'image', 'reasoning'], contextWindow: 64_000, maxTokens: 8_000, catalog })
    await service.setModelCapabilities(connection.id, id, null)
    expect((await service.listModels(connection.id))[0]?.capabilities).toEqual(['text'])
    f.setBody({ data: [{ id }] })
    await service.syncModels(connection.id)
    expect((await service.listModels(connection.id))[0]).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536, catalog })
  })

  it('preserves omitted states, overrides, manual models and defaults through partial pages, restart and recovery', async () => {
    const f = await fixture()
    const omittedId = 'omitted-model'
    f.setBody({ models: [directoryModel, { ...directoryModel, slug: omittedId }] })
    await f.service.syncModels(connection.id)
    await f.service.setModelEnabled(connection.id, omittedId, true)
    await f.service.setProviderEnabled(connection.id, true)
    await f.service.setModelCapabilities(connection.id, omittedId, { image: false })
    await f.service.setModelParametersOverride(connection.id, omittedId, { contextWindow: 64_000, maxTokens: 8_000 })
    await f.service.setDefaultModel({ providerId: connection.id, modelId: omittedId, reasoning: 'high' })
    await f.service.upsertManualModel(connection.id, { id: 'manual', name: 'Manual model', input: ['text'], reasoning: false })
    const omitted = f.repository.models.find(connection.id, omittedId)
    const manual = f.repository.models.find(connection.id, 'manual')
    const defaultModel = await f.service.getDefaultModel()

    f.setBody({ data: [{ id: directoryModel.slug, name: 'Updated model' }, { id: 'new-model' }, { id: 'manual', name: 'Ignored' }], has_more: true })
    const synced = await f.service.syncModels(connection.id)
    expect(f.repository.models.find(connection.id, omittedId)).toEqual(omitted)
    expect(f.repository.models.find(connection.id, 'manual')).toEqual(manual)
    expect(await f.service.getDefaultModel()).toEqual(defaultModel)
    expect(synced).toContainEqual(expect.objectContaining({ id: directoryModel.slug, displayName: 'Updated model', available: true }))
    expect(synced).toContainEqual(expect.objectContaining({ id: 'new-model', available: true, enabled: false }))
    f.setBody({ data: [], has_more: true })
    expect(await f.service.syncModels(connection.id)).toEqual(synced)

    await f.service.dispose()
    const { service } = await f.setup()
    expect(await service.listModels(connection.id)).toEqual(synced)
    expect(await service.getDefaultModel()).toEqual(defaultModel)
    f.setStatus(503)
    await expect(service.syncModels(connection.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(await service.listModels(connection.id)).toEqual(synced)

    f.setStatus(200)
    f.setBody({ data: [], has_more: false, total: 0 })
    const empty = await service.syncModels(connection.id)
    const unavailable = empty.filter(model => model.source === 'synced')
    expect(unavailable).toHaveLength(3)
    expect(unavailable.every(model => !model.available)).toBe(true)
    expect(f.repository.models.find(connection.id, 'manual')).toEqual(manual)
    expect(f.repository.models.find(connection.id, omittedId)).toMatchObject({ enabled: true, capabilityOverrides: { image: false }, overrideContextWindow: 64_000, overrideMaxTokens: 8_000 })
    expect(await service.getDefaultModel()).toEqual(defaultModel)

    f.setBody({ data: [{ id: directoryModel.slug }], has_more: true })
    const partial = await service.syncModels(connection.id)
    expect(partial).toContainEqual(expect.objectContaining({ id: directoryModel.slug, available: true }))
    expect(partial).toContainEqual(expect.objectContaining({ id: omittedId, available: false, enabled: true }))
  })

  it('rejects late discovery when a run starts before the result is committed', async () => {
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let waiting = false
    const f = await fixture(async () => {
      if (!waiting)
        return Response.json({ models: [directoryModel] })
      started.resolve()
      await gate.promise
      return Response.json({ data: [], has_more: false })
    })
    await f.service.syncModels(connection.id)
    const previous = await f.service.listModels(connection.id)
    waiting = true
    const pending = f.service.syncModels(connection.id)
    await started.promise
    f.setActiveRuns([{ provider: connection.id, model: directoryModel.slug }])
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_HAS_ACTIVE_RUNS' })
    expect(await f.service.listModels(connection.id)).toEqual(previous)
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
