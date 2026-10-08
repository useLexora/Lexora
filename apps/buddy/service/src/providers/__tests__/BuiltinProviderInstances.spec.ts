import type { AnyModel, Api, AssistantMessage, Context, Model, Provider } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, isModelType, lazyStream } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { createProviderStateRepository } from '../../storage/providerStateRepository'
import { createWorkspaceRepository } from '../../storage/workspaceRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { createBuiltinProviderInstance } from '../createBuiltinProviderInstance'
import { createProviderLoginOptions } from '../createProviderLoginOptions'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'
import { providerAuthChallengeSchema } from '../providerSchemas'
import { ProviderService } from '../ProviderService'
import { resolveInteractiveModelSelection } from '../resolveInteractiveModelSelection'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

describe('built-in provider instances', () => {
  it('restores credential-only Azure accounts and runs both Responses and Foundry chat models through their original identity', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const providerId = 'azure-openai-responses'
    await credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: 'fixture-azure-key',
      env: { AZURE_OPENAI_BASE_URL: 'https://azure.example.test/v1' },
    }))
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const service = new ProviderService({
      authInteractions: new AuthInteractionService(),
      credentialStatus: createProviderCredentialStatus(credentials),
      modelDiscovery: { supports: () => false, discover: async () => [] },
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      sessionRuntime: runtime,
    })
    try {
      await service.initializeProviders()
      expect(await service.listProviders()).toContainEqual(expect.objectContaining({ id: providerId, builtinProviderId: 'azure', status: 'available' }))
      expect(service.listBuiltinPresets().filter(preset => preset.id.startsWith('azure'))).toMatchObject([{ id: 'azure' }])
      expect(await credentials.read(providerId)).toMatchObject({ key: 'fixture-azure-key' })
      const requests: Array<{ url: string, headers: Headers }> = []
      const request: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Azure answer', annotations: [] }] }
        const events = String(input).includes('/chat/completions')
          ? [{ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Azure answer' }, finish_reason: 'stop' }] }]
          : [
              { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
              { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Azure answer' },
              { type: 'response.output_item.done', output_index: 0, item },
              { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
            ]
        return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      for (const api of ['azure-openai-responses', 'openai-completions']) {
        const model = runtime.getModels(providerId).find(model => model.api === api)!
        expect(model).toBeDefined()
        const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, { fetch: request })
        expect(result, result.errorMessage).toMatchObject({ provider: providerId, stopReason: 'stop', content: [expect.objectContaining({ type: 'text', text: 'Azure answer' })] })
        expect(result.durationMs).toEqual(expect.any(Number))
        const headers = requests.at(-1)!.headers
        expect(headers.get('authorization') ?? headers.get('api-key')).toContain('fixture-azure-key')
      }
      expect(requests.every(request => request.url.startsWith('https://azure.example.test/'))).toBe(true)
      const other = await service.addProvider('azure')
      expect(other).toMatchObject({ builtinProviderId: 'azure', status: 'authentication_required' })
      expect(await credentials.read(other.id)).toBeUndefined()
    }
    finally {
      await service.dispose()
    }
  })

  it('preserves mixed catalogs and authenticates each operation with its own instance and headers', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const states = createProviderStateRepository(database)
    const headers = new ProviderRequestHeaders(states)
    const registration = createProviderModelRuntime(runtime, headers)
    const { provider } = createSource()
    const chat = provider.getModels()[0]!
    const base = { id: chat.id, name: chat.name, provider: provider.id, baseUrl: chat.baseUrl, input: chat.input, cost: chat.cost }
    const catalog: AnyModel[] = [chat, { ...base, type: 'image', api: 'fixture-images', output: ['image'] }, { ...base, type: 'classifier', api: 'fixture-classifier', contextWindow: 8000 }]
    provider.getAllModels = () => catalog
    provider.filterAllModels = models => models.filter(model => model.provider === provider.id)
    const requests: unknown[] = []
    provider.generateImages = async (model, _context, options) => {
      requests.push({ model, key: options?.apiKey, headers: options?.headers })
      return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: 'stop', timestamp: 1 }
    }
    provider.classify = async (model, _context, options) => {
      requests.push({ model, key: options?.apiKey, headers: options?.headers })
      return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: 'stop', timestamp: 1 }
    }
    for (const id of ['account-a', 'account-b']) {
      states.upsert({ providerId: id, enabled: true, createdAt: 'now', updatedAt: 'now' })
      registration.registerNativeProvider(createBuiltinProviderInstance({ id, name: id, source: provider, getCatalogModels: () => catalog }))
      await credentials.modify(id, async () => ({ type: 'api_key', key: `fixture-${id}` }))
      headers.save(id, [{ name: 'X-Account', value: id }, { name: 'X-Token', value: `\${apiKey}` }])
      expect(runtime.getModels(id)).toMatchObject([{ id: chat.id, provider: id }])
      expect(await runtime.getAllAvailable(id)).toHaveLength(3)
      const image = runtime.getModelOfType('image', id, chat.id)!
      const classifier = runtime.getModelOfType('classifier', id, chat.id)!
      expect(await runtime.generateImages(image, { input: [{ type: 'text', text: 'fixture' }] })).toMatchObject({ provider: id, stopReason: 'stop' })
      expect(await runtime.classify(classifier, { state: {}, questions: {} })).toMatchObject({ provider: id, stopReason: 'stop' })
      expect(requests.slice(-2)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ model: expect.objectContaining({ provider: provider.id }), key: `fixture-${id}`, headers: expect.objectContaining({ 'x-account': id, 'x-token': `fixture-${id}` }) })))
    }
    expect(catalog.every(model => model.provider === provider.id)).toBe(true)
  })

  it('reuses a lazily persisted installation ID across provider logins and runtime recreation', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const settings = createWorkspaceRepository(database)
    const ids: string[] = []
    const credentials = new InMemoryCredentialStore()
    const setup = async () => {
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const source = () => {
        const { provider } = createSource()
        provider.auth.oauth!.login = async (_interaction, options) => {
          expect(options?.agentName).toBe('Lexora')
          const id = options?.getDeviceId?.()
          expect(id).toMatch(/^[0-9a-f-]{36}$/)
          ids.push(id!)
          return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 }
        }
        return provider
      }
      runtime.registerNativeProvider(source())
      const service = new ProviderService({
        authInteractions: new AuthInteractionService(),
        createBuiltinSource: source,
        credentialStatus: createProviderCredentialStatus(credentials),
        loginOptions: createProviderLoginOptions(createWorkspaceRepository(database)),
        modelDiscovery: { supports: () => false, discover: async () => [] },
        modelRuntime: runtime,
        providers: createProviderRepository(database),
      })
      await service.initializeProviders()
      return service
    }
    const first = await setup()
    const account = await first.addProvider('fixture-builtin')
    expect(settings.listKeys()).toEqual([])
    await first.login(account.id, 'oauth')
    await first.dispose()
    const restored = await setup()
    await restored.login(account.id, 'oauth')
    const other = await restored.addProvider('fixture-builtin')
    await restored.login(other.id, 'oauth')
    await restored.dispose()
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(settings.get('buddy.providers.device-id')).toBe(ids[0])
  })

  it('keeps account model availability consistent across login, sync and runtime recreation', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const setup = async () => {
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const source = () => {
        const { provider } = createSource()
        const baseline = provider.getModels()[0]!
        provider.getModels = () => [baseline, { ...baseline, id: 'excluded-model' }]
        provider.filterModels = (models, credential) => credential?.type === 'api_key'
          ? models.filter(model => model.id === 'fixture-model')
          : []
        return provider
      }
      runtime.registerNativeProvider(source())
      const authInteractions = new AuthInteractionService()
      authInteractions.onDidChallenge((input) => {
        const challenge = providerAuthChallengeSchema.parse(input)
        if (challenge.type === 'secret')
          authInteractions.respondToPrompt(challenge.challengeId, 'fixture-not-a-real-key')
      })
      const service = new ProviderService({
        authInteractions,
        createBuiltinSource: source,
        credentialStatus: createProviderCredentialStatus(credentials),
        modelDiscovery: { supports: () => false, discover: async () => [] },
        modelRuntime: runtime,
        providers: createProviderRepository(database),
      })
      await service.initializeProviders()
      return service
    }
    const service = await setup()
    const instance = await service.addProvider('fixture-builtin')
    expect(await service.listModels(instance.id)).toHaveLength(2)
    await service.setModelEnabled(instance.id, 'excluded-model', true)
    await service.setModelParametersOverride(instance.id, 'excluded-model', { contextWindow: 8000, maxTokens: 2000 })
    const expectAccountModels = async (service: ProviderService) => {
      expect(await service.listModels(instance.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'fixture-model', available: true, enabled: false }),
        expect.objectContaining({ id: 'excluded-model', available: false, enabled: true, contextWindow: 8000, maxTokens: 2000 }),
      ]))
      await expect(service.setModelEnabled(instance.id, 'excluded-model', true)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    }
    await service.login(instance.id, 'api_key')
    await expectAccountModels(service)
    await service.syncModels(instance.id)
    await expectAccountModels(service)
    const restored = await setup()
    await expectAccountModels(restored)
    const knownModels = await restored.listModels(instance.id)
    await restored.clearCredential(instance.id)
    const unauthenticated = await setup()
    await expectAccountModels(unauthenticated)
    expect(await unauthenticated.listModels(instance.id)).toEqual(knownModels)
    expect(await unauthenticated.listProviders()).toContainEqual(expect.objectContaining({ id: instance.id, status: 'authentication_required' }))
    await unauthenticated.login(instance.id, 'api_key')
    await expectAccountModels(unauthenticated)
  })

  it('keeps mixed account catalogs separate across refresh and offline restoration', async () => {
    const credentials = new InMemoryCredentialStore()
    const modelsStore = new InMemoryModelsStore()
    const setup = () => {
      const models = createModels({ credentials, modelsStore })
      for (const id of ['account-a', 'account-b']) {
        const { provider } = createSource()
        const baseline = provider.getModels()[0]!
        let catalog: readonly AnyModel[] = []
        provider.getModels = () => catalog.filter(model => isModelType(model, 'chat'))
        provider.getAllModels = () => catalog
        provider.refreshModels = async (context) => {
          const next: readonly AnyModel[] = context.allowNetwork && context.credential?.type === 'api_key'
            ? [
                { ...baseline, id: context.credential.key! },
                { id: context.credential.key!, name: 'Image model', provider: provider.id, type: 'image', api: 'fixture-images', baseUrl: baseline.baseUrl, input: ['text'], output: ['image'], cost: baseline.cost },
              ]
            : context.stored?.models.filter(model => model.provider === provider.id) ?? []
          await context.publish({
            persist: { models: next },
            update: () => {
              catalog = next
            },
          })
        }
        models.setProvider(createBuiltinProviderInstance({ id, name: id, source: provider, getCatalogModels: () => [] }))
      }
      return models
    }
    const models = setup()
    for (const id of ['account-a', 'account-b'])
      await models.login(id, 'api_key', { notify: () => {}, prompt: async () => `${id}-model` })
    await models.refresh({ allowNetwork: true })
    for (const id of ['account-a', 'account-b']) {
      expect(models.getModels(id)).toMatchObject([{ provider: id, id: `${id}-model` }])
      expect(models.getModelOfType('image', id, `${id}-model`)).toMatchObject({ provider: id, id: `${id}-model`, type: 'image' })
      expect(await modelsStore.read(id)).toMatchObject({ models: [
        { provider: id, id: `${id}-model` },
        { provider: id, id: `${id}-model`, type: 'image' },
      ] })
    }
    const restored = setup()
    await restored.refresh({ allowNetwork: false })
    for (const id of ['account-a', 'account-b']) {
      expect(restored.getModels(id)).toMatchObject([{ provider: id, id: `${id}-model` }])
      expect(restored.getModelOfType('image', id, `${id}-model`)).toMatchObject({ provider: id, id: `${id}-model`, type: 'image' })
    }
  })

  it('resolves service tiers using the built-in source instead of the instance identifier', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const service = new ProviderService({
      authInteractions: new AuthInteractionService(),
      credentialStatus: createProviderCredentialStatus(credentials),
      modelDiscovery: { supports: () => false, discover: async () => [] },
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      sessionRuntime: runtime,
    })
    const instance = await service.addProvider('openai-codex')
    expect(service.executionModels.getServiceTiers({ providerId: instance.id, modelId: 'gpt-5.6-sol', api: 'openai-codex-responses' }))
      .toEqual([{ displayName: 'Fast', id: 'priority' }])
    expect(service.executionModels.getServiceTiers({ providerId: instance.id, modelId: 'gpt-6-astra', api: 'openai-codex-responses' }))
      .toEqual([{ displayName: 'Fast', id: 'priority' }])
    expect(service.executionModels.getServiceTiers({ providerId: instance.id, modelId: 'gpt-6-astra', api: 'openai-responses' }))
      .toEqual([])
    expect(service.executionModels.getServiceTiers({ providerId: 'custom-proxy', modelId: 'gpt-5.6-sol', api: 'openai-codex-responses' }))
      .toEqual([])
    const openai = await service.addProvider('openai')
    expect(service.executionModels.getServiceTiers({ providerId: openai.id, modelId: 'gpt-6-astra', api: 'openai-responses' }))
      .toEqual([{ displayName: 'Fast', id: 'priority' }])
    expect(service.executionModels.getServiceTiers({ providerId: openai.id, modelId: 'gpt-5.4-nano', api: 'openai-responses' }))
      .toEqual([])
    expect(service.executionModels.getServiceTiers({ providerId: openai.id, modelId: 'gpt-6-astra', api: 'openai-completions' }))
      .toEqual([])
    expect(service.executionModels.getServiceTiers({ providerId: 'custom-proxy', modelId: 'gpt-6-astra', api: 'openai-responses' }))
      .toEqual([])
  })

  it('updates Fast selection with the active snapshot without changing model availability or reasoning', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    const data = (fast: boolean) => ({ openai: { name: 'OpenAI', npm: '@ai-sdk/openai', models: {
      'gpt-5.5': {
        name: 'GPT-5.5',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128_000, output: 16_384 },
        experimental: fast ? { modes: { fast: { provider: { body: { service_tier: 'priority' } } } } } : undefined,
      },
    } } })
    let fast = true
    const service = new ProviderService({
      authInteractions: new AuthInteractionService(),
      credentialStatus: createProviderCredentialStatus(credentials),
      modelDiscovery: { supports: () => false, discover: async () => [] },
      modelRuntime: runtime,
      modelSnapshot: new ProviderModelSnapshotService({
        builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data: data(false) },
        fetch: async () => Response.json(data(fast)),
      }),
      providers: createProviderRepository(database),
    })
    const instance = await service.addProvider('openai')
    await runtime.login(instance.id, 'api_key', { notify: () => {}, prompt: async () => 'fixture-not-a-real-key' })
    await service.setModelEnabled(instance.id, 'gpt-5.5', true)
    await service.setProviderEnabled(instance.id, true)
    const input = { providerId: instance.id, modelId: 'gpt-5.5', api: 'openai-responses' }
    const selection = { providerId: instance.id, modelId: 'gpt-5.5', reasoning: 'high' as const, serviceTier: 'priority' as const }
    expect(service.executionModels.getServiceTiers(input)).toEqual([])
    await expect(resolveInteractiveModelSelection(service, selection)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    const before = await service.listModels(instance.id)
    await expect(service.refreshModelSnapshot()).resolves.toMatchObject({ errorCount: 0 })
    expect(service.executionModels.getServiceTiers(input)).toEqual([{ displayName: 'Fast', id: 'priority' }])
    await expect(resolveInteractiveModelSelection(service, selection)).resolves.toMatchObject(selection)
    expect(await service.listModels(instance.id)).toEqual(before)

    fast = false
    await service.refreshModelSnapshot()
    expect(service.executionModels.getServiceTiers(input)).toEqual([])
    await expect(resolveInteractiveModelSelection(service, selection)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(resolveInteractiveModelSelection(service, { ...selection, serviceTier: null })).resolves.toMatchObject({ serviceTier: null })
  })

  it('keeps independent credentials, model overrides, names and defaults across runtime recreation', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const credentials = new InMemoryCredentialStore()
    const sources = createSource()
    const setup = async () => {
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      runtime.registerNativeProvider(sources.provider)
      const service = new ProviderService({
        authInteractions: new AuthInteractionService(),
        createBuiltinSource: () => sources.provider,
        credentialStatus: createProviderCredentialStatus(credentials),
        modelDiscovery: { supports: () => false, discover: async () => [] },
        modelRuntime: runtime,
        providers: createProviderRepository(database),
        sessionRuntime: runtime,
      })
      await service.initializeProviders()
      return { service, runtime }
    }
    const { service, runtime } = await setup()
    expect(await service.listProviders()).toEqual([])
    const snapshotBefore = await service.getModelSnapshot()
    const first = await service.addProvider('fixture-builtin')
    const second = await service.addProvider('fixture-builtin')
    expect(first.id).not.toBe(second.id)
    expect(first.displayName).toBe('Fixture')
    expect(second.displayName).toBe('Fixture 2')
    expect(service.listBuiltinPresets().filter(preset => preset.id === 'fixture-builtin')).toHaveLength(1)
    expect(await service.getModelSnapshot()).toMatchObject({ modelCount: snapshotBefore.modelCount, providerCount: snapshotBefore.providerCount })
    for (const [instance, key] of [[first, 'fixture-first'], [second, 'fixture-second']] as const) {
      await runtime.login(instance.id, 'api_key', { notify: () => {}, prompt: async () => key })
      await service.setModelEnabled(instance.id, 'fixture-model', true)
      await service.setProviderEnabled(instance.id, true)
    }
    await service.renameProvider(second.id, 'Work')
    await service.setModelParametersOverride(first.id, 'fixture-model', { contextWindow: 8000, maxTokens: 2000 })
    await service.setDefaultModel({ providerId: first.id, modelId: 'fixture-model', reasoning: null })
    for (const instance of [first, second]) {
      const resolved = await service.executionModels.resolveSession({ providerId: instance.id, modelId: 'fixture-model', contextWindow: null, maxTokens: null })
      const answer = await resolved.runtime.completeSimple(resolved.model, { messages: [] })
      expect(answer.provider).toBe(instance.id)
    }
    expect(sources.requests.map(request => request.key)).toEqual(['fixture-first', 'fixture-second'])
    expect(sources.requests.map(request => request.provider)).toEqual(['fixture-builtin', 'fixture-builtin'])
    expect((await service.listModels(second.id))[0]).toMatchObject({ hasParameterOverride: false, contextWindow: 16000, maxTokens: 4000 })

    const restored = await setup()
    expect(await restored.service.listProviders()).toContainEqual(expect.objectContaining({ id: second.id, displayName: 'Work', enabled: true }))
    expect((await restored.service.listModels(first.id))[0]).toMatchObject({ hasParameterOverride: true, contextWindow: 8000, maxTokens: 2000 })
    expect(await restored.service.getDefaultModel()).toMatchObject({ providerId: first.id })
    await restored.service.removeProvider(second.id)
    expect(await credentials.read(second.id)).toBeUndefined()
    expect(await credentials.read(first.id)).toMatchObject({ key: 'fixture-first' })
    expect(await restored.service.getDefaultModel()).toMatchObject({ providerId: first.id })
    expect(await restored.service.listProviders()).toHaveLength(1)
    expect((await restored.service.listModels(first.id))[0]?.enabled).toBe(true)
  })

  it('refreshes OAuth tokens only for the selected instance and preserves stream identity', async () => {
    const sources = createSource()
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    for (const id of ['account-a', 'account-b']) {
      runtime.registerNativeProvider(createBuiltinProviderInstance({ id, name: id, source: sources.provider, getCatalogModels: () => sources.provider.getModels() }))
      await runtime.login(id, 'oauth', { notify: () => {}, prompt: async () => id })
    }
    const model = runtime.getModels('account-a')[0]!
    const ownHistory = answer(model)
    const legacyHistory = { ...ownHistory, provider: 'fixture-builtin' }
    const observedProviders: string[] = []
    const stream = runtime.streamSimple(model, { messages: [legacyHistory, ownHistory] }, {
      onProviderStreamEvent: (_data, observed) => { observedProviders.push(observed.provider) },
    })
    const events = []
    for await (const event of stream)
      events.push(event)
    expect(events.map(event => event.type)).toEqual(['start', 'done'])
    expect(events[0]).toMatchObject({ partial: { provider: 'account-a' } })
    expect(await stream.result()).toMatchObject({ provider: 'account-a' })
    expect(observedProviders).toEqual(['account-a'])
    expect(await credentials.read('account-a')).toMatchObject({ access: 'refreshed-account-a' })
    expect(await credentials.read('account-b')).toMatchObject({ access: 'account-b' })
    expect(sources.requests[0]?.context.messages).toMatchObject([
      { provider: 'builtin-instance:fixture-builtin' },
      { provider: 'fixture-builtin' },
    ])
    expect(ownHistory.provider).toBe('account-a')
    await runtime.logout('account-b')
    expect(await credentials.read('account-a')).toBeDefined()
    expect(await credentials.read('account-b')).toBeUndefined()
  })
})

function createSource() {
  const requests: Array<{ provider: string, key: string | undefined, context: Context }> = []
  const model: Model<Api> = {
    provider: 'fixture-builtin',
    id: 'fixture-model',
    name: 'Fixture Model',
    api: 'openai-completions',
    baseUrl: 'https://models.example.test/v1',
    input: ['text'],
    reasoning: false,
    contextWindow: 16000,
    maxTokens: 4000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const stream: Provider['streamSimple'] = (model, context, options) => lazyStream(model, async () => {
    await options?.onProviderStreamEvent?.({ type: 'fixture' }, model)
    requests.push({ provider: model.provider, key: options?.apiKey, context })
    const message = answer(model)
    return (async function* () {
      yield { type: 'start' as const, partial: message }
      yield { type: 'done' as const, reason: 'stop' as const, message }
    })()
  })
  const provider: Provider = {
    id: model.provider,
    name: 'Fixture',
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: 'Fixture key',
        login: async interaction => ({ type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'API Key' }) }),
        resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key } } : undefined,
      },
      oauth: {
        name: 'Fixture OAuth',
        login: async (interaction) => {
          const account = await interaction.prompt({ type: 'text', message: 'Account' })
          return { type: 'oauth', access: account, refresh: account, expires: 0 }
        },
        refresh: async credential => ({ ...credential, access: `refreshed-${credential.refresh}`, expires: Date.now() + 3600000 }),
        toAuth: async credential => ({ apiKey: credential.access }),
      },
    },
    getModels: () => [model],
    stream: (model, context, options) => stream(model, context, { apiKey: options?.apiKey }),
    streamSimple: stream,
  }
  return { provider, requests }
}

function answer(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: 'Fixture answer' }],
    stopReason: 'stop',
    timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}
