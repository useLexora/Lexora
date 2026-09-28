import type { Api, AssistantMessage, Context, Model, Provider } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, lazyStream } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { createBuiltinProviderInstance } from '../createBuiltinProviderInstance'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { providerAuthChallengeSchema } from '../providerSchemas'
import { ProviderService } from '../ProviderService'
import { resolveInteractiveModelSelection } from '../resolveInteractiveModelSelection'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

describe('built-in provider instances', () => {
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

  it('keeps credential-specific dynamic catalogs separate when refreshing and restoring caches', async () => {
    const credentials = new InMemoryCredentialStore()
    const modelsStore = new InMemoryModelsStore()
    const setup = () => {
      const models = createModels({ credentials, modelsStore })
      for (const id of ['account-a', 'account-b']) {
        const { provider } = createSource()
        const baseline = provider.getModels()[0]!
        let catalog: readonly Model<Api>[] = []
        provider.getModels = () => catalog
        provider.refreshModels = async (context) => {
          const next = context.allowNetwork && context.credential?.type === 'api_key'
            ? [{ ...baseline, id: context.credential.key! }]
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
      expect(await modelsStore.read(id)).toMatchObject({ models: [{ provider: id, id: `${id}-model` }] })
    }
    const restored = setup()
    await restored.refresh({ allowNetwork: false })
    expect(restored.getModels('account-a')).toMatchObject([{ provider: 'account-a', id: 'account-a-model' }])
    expect(restored.getModels('account-b')).toMatchObject([{ provider: 'account-b', id: 'account-b-model' }])
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
    const stream = runtime.streamSimple(model, { messages: [legacyHistory, ownHistory] })
    const events = []
    for await (const event of stream)
      events.push(event)
    expect(events.map(event => event.type)).toEqual(['start', 'done'])
    expect(events[0]).toMatchObject({ partial: { provider: 'account-a' } })
    expect(await stream.result()).toMatchObject({ provider: 'account-a' })
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
