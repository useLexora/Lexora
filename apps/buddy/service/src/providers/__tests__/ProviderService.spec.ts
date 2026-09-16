import type {
  Api,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialInfo,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { DatabaseSync } from 'node:sqlite'
import type { ProviderModelDiscovery } from '../ProviderModelDiscovery'
import type { ProviderServiceOptions } from '../ProviderService'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'

import { createProviderRepository } from '../../storage/providerRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { HostCredentialStoreError } from '../HostCredentialStore'
import { supportsModelPdfInput } from '../modelCapabilities'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { ProviderService } from '../ProviderService'

const databasePaths: string[] = []

afterEach(async () => {
  await Promise.all(databasePaths.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('providerService', () => {
  it('rejects custom creation collisions without overwriting provider configuration', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const runtime = new FakeModelRuntime()
      runtime.providers = [provider('xiaomi')]
      const repository = createProviderRepository(database)
      const service = createProviderServiceForTest({ authInteractions: new AuthInteractionService({ notify: () => {} }), modelRuntime: runtime, providers: repository })
      const input = { api: 'openai-completions' as const, baseUrl: 'https://proxy.example.test/v1', displayName: 'xiaomi', enabled: false, id: 'custom-xiaomi', models: [] }
      await expect(service.createCustomProvider({ ...input, id: 'xiaomi' })).rejects.toMatchObject({ code: 'PROVIDER_ID_CONFLICT' })
      expect(repository.configs.findById('xiaomi')).toBeNull()
      await service.createCustomProvider(input)
      const original = repository.configs.findById(input.id)
      await expect(service.createCustomProvider({ ...input, baseUrl: 'https://other.example.test/v1', displayName: 'replacement' })).rejects.toMatchObject({ code: 'PROVIDER_ID_CONFLICT' })
      expect(repository.configs.findById(input.id)).toEqual(original)
      await expect(service.createCustomProvider({ ...input, id: 'custom-another' })).resolves.toMatchObject({ id: 'custom-another', displayName: 'xiaomi' })
      await expect(service.upsertCustomProvider({ ...input, displayName: 'renamed' })).resolves.toMatchObject({ displayName: 'renamed' })
    }
    finally {
      database.close()
    }
  })

  it('preserves configured media capabilities independently from native channel transport support', async () => {
    const runtime = new FakeModelRuntime()
    runtime.providers = builtinProviders().filter(provider => ['openai-codex', 'google'].includes(provider.id))
    runtime.models = runtime.providers.flatMap(provider => provider.getModels()).filter(model => ['gpt-5.5', 'gpt-5.4-mini', 'gemini-2.5-pro'].includes(model.id))
    runtime.credentials = runtime.providers.map(provider => ({ providerId: provider.id, type: provider.id === 'google' ? 'api_key' : 'oauth' } as CredentialInfo))
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const service = createProviderServiceForTest({ authInteractions: new AuthInteractionService({ notify: () => {} }), modelRuntime: runtime, providers: createProviderRepository(database), modelSnapshot: new ProviderModelSnapshotService() })
      await service.initializeProviders()
      const codex = (await service.listModels('openai-codex')).find(model => model.id === 'gpt-5.5')!
      expect(codex.capabilities).toContain('pdf')
      expect(codex.contextWindow).toBe(runtime.models.find(model => model.id === 'gpt-5.5')!.contextWindow)
      expect((await service.listModels('openai-codex')).find(model => model.id === 'gpt-5.4-mini')!.capabilities).not.toContain('pdf')
      expect((await service.listModels('google'))[0]!.capabilities).toEqual(expect.arrayContaining(['image', 'pdf', 'audio', 'video']))
      const overrides = { image: true, audio: true, video: true, reasoningOptions: ['off'] as const }
      await service.setModelCapabilities('openai-codex', 'gpt-5.5', { ...overrides, reasoningOptions: [...overrides.reasoningOptions] })
      await service.initializeProviders()
      const configured = (await service.listModels('openai-codex')).find(model => model.id === 'gpt-5.5')!
      expect(configured.capabilityOverrides).toEqual(overrides)
      expect(configured.capabilities).not.toContain('audio')
      expect(configured.capabilities).not.toContain('video')
    }
    finally {
      database.close()
    }
  })

  it('registers custom provider metadata without accepting secrets', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const runtime = new FakeModelRuntime()
    runtime.credentials = [{ providerId: 'openai-proxy', type: 'api_key' } as CredentialInfo]
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
    })

    await service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      displayName: 'Example Models',
      enabled: true,
      id: 'example-models',
      models: [{
        contextWindow: 128_000,
        id: 'reasoner',
        input: ['text'],
        maxTokens: 16_384,
        name: 'Reasoner',
        reasoning: true,
      }],
    })

    expect(runtime.registered).toEqual([{
      config: expect.objectContaining({
        api: 'openai-responses',
        baseUrl: 'https://models.example.test/v1',
        name: 'Example Models',
      }),
      providerId: 'example-models',
    }])
    await expect(service.upsertCustomProvider({
      api: 'openai-responses',
      apiKey: 'sk-test-secret',
      baseUrl: 'https://models.example.test/v1',
      displayName: 'Unsafe',
      id: 'unsafe',
      models: [],
    } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      displayName: 'Untrusted metadata',
      enabled: false,
      id: 'untrusted-metadata',
      models: [{
        catalogProviderId: 'openai',
        id: 'model-1',
        input: ['text'],
        reasoning: false,
      }],
    } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'http://models.example.test/v1',
      displayName: 'Insecure remote',
      enabled: true,
      id: 'insecure-remote',
      models: [{
        contextWindow: 4096,
        id: 'model-1',
        input: ['text'],
        maxTokens: 1024,
        name: 'Model',
        reasoning: false,
      }],
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    database.close()
  })

  it('requires a currently authenticated and available provider before resolving a run model', async () => {
    const runtime = new FakeModelRuntime()
    runtime.providers = [{
      auth: { apiKey: {} },
      baseUrl: 'https://api.anthropic.com',
      id: 'anthropic',
      name: 'Anthropic',
    } as Provider]
    runtime.models = [model('anthropic', 'model-1')]
    const sessionRuntime = {} as ModelRuntime
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      sessionRuntime,
    })

    await restoreLegacyProvider(service, database, 'anthropic')
    await service.setModelEnabled('anthropic', 'model-1', true)
    const selection = {
      contextWindow: null,
      maxTokens: null,
      modelId: 'model-1',
      providerId: 'anthropic',
    }
    await expect(service.executionModels.resolveAvailable(selection)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
    runtime.credentials = [{ providerId: 'anthropic', type: 'api_key' } as CredentialInfo]
    await service.setProviderEnabled('anthropic', true)
    await expect(service.executionModels.resolveAvailable(selection)).resolves.toMatchObject(runtime.models[0]!)
    await expect(service.executionModels.resolveSession(selection)).resolves.toEqual({
      model: expect.objectContaining(runtime.models[0]!),
      runtime: sessionRuntime,
    })
    runtime.credentials = []
    await expect(service.executionModels.resolveAvailable(selection)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    })
    runtime.credentialsError = new HostCredentialStoreError('CREDENTIAL_STORE_UNAVAILABLE')
    await expect(service.executionModels.resolveAvailable(selection)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    })
    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic', status: 'authentication_required' }),
    ])
    runtime.credentialsError = null
    runtime.credentials = [{ providerId: 'anthropic', type: 'api_key' } as CredentialInfo]
    await expect(service.executionModels.resolveAvailable({
      ...selection,
      contextWindow: 64_000,
      maxTokens: 8_000,
    })).resolves.toMatchObject({ contextWindow: 64_000, maxTokens: 8_000 })
    await expect(service.executionModels.resolveAvailable({
      ...selection,
      contextWindow: 64_000,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(service.executionModels.resolveAvailable({
      ...selection,
      providerId: 'missing',
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
    database.close()
  })

  it('keeps source parameters, user overrides, and source-update acknowledgement separate', async () => {
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('anthropic')]
    runtime.models = [model('anthropic', 'claude')]
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
    })

    await restoreLegacyProvider(service, database, 'anthropic')
    await expect(service.setModelParametersOverride('anthropic', 'claude', {
      contextWindow: 8_000,
      maxTokens: 16_000,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await service.listModels('anthropic')).toEqual([
      expect.objectContaining({ hasParameterOverride: false }),
    ])
    await service.setModelParametersOverride('anthropic', 'claude', {
      contextWindow: 200_000,
      maxTokens: 32_000,
    })
    expect(await service.listModels('anthropic')).toEqual([
      expect.objectContaining({
        contextWindow: 200_000,
        hasParameterOverride: true,
        maxTokens: 32_000,
        sourceContextWindow: 128_000,
        sourceMaxTokens: 16_384,
        sourceParametersUpdated: false,
      }),
    ])
    expect(service.executionModels.resolve({
      contextWindow: null,
      maxTokens: null,
      modelId: 'claude',
      providerId: 'anthropic',
    })).toMatchObject({
      contextWindow: 200_000,
      maxTokens: 32_000,
    })

    runtime.models = [{
      ...runtime.models[0]!,
      contextWindow: 256_000,
      maxTokens: 64_000,
    }]
    await service.initializeProviders()
    expect(await service.listModels('anthropic')).toEqual([
      expect.objectContaining({
        contextWindow: 200_000,
        maxTokens: 32_000,
        sourceContextWindow: 256_000,
        sourceMaxTokens: 64_000,
        sourceParametersUpdated: true,
      }),
    ])

    await service.acknowledgeModelSourceUpdate('anthropic', 'claude')
    expect(await service.listModels('anthropic')).toEqual([
      expect.objectContaining({
        contextWindow: 200_000,
        hasParameterOverride: true,
        sourceParametersUpdated: false,
      }),
    ])

    await service.restoreModelSourceParameters('anthropic', 'claude')
    expect(await service.listModels('anthropic')).toEqual([
      expect.objectContaining({
        contextWindow: 256_000,
        hasParameterOverride: false,
        maxTokens: 64_000,
        sourceParametersUpdated: false,
      }),
    ])
    database.close()
  })

  it('enriches service-discovered models from a unique snapshot match without replacing user state', async () => {
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('openai')]
    runtime.models = [{
      ...model('openai', 'reasoner'),
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { max: null, xhigh: 'xhigh' },
    }]
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelDiscovery: createTestModelDiscovery(() => Promise.resolve([{ id: 'reasoner' }])),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
    })

    await service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.test/v1',
      displayName: 'OpenAI proxy',
      enabled: false,
      id: 'openai-proxy',
      models: [],
    })
    await service.syncModels('openai-proxy')
    expect(await service.listModels('openai-proxy')).toEqual([
      expect.objectContaining({
        capabilities: ['text', 'image', 'reasoning'],
        catalogMatch: 'matched',
        source: 'synced',
        sourceContextWindow: 128_000,
      }),
    ])
    database.exec(`
      UPDATE provider_model_states
      SET catalog_provider_id = NULL,
          source_fingerprint = '',
          thinking_level_map_json = NULL
      WHERE provider_id = 'openai-proxy' AND model_id = 'reasoner'
    `)
    await service.refreshModelSnapshot()
    const migratedMetadata = database.prepare(`
      SELECT catalog_provider_id, source_fingerprint, thinking_level_map_json
      FROM provider_model_states
      WHERE provider_id = 'openai-proxy' AND model_id = 'reasoner'
    `).get() as {
      catalog_provider_id: string | null
      source_fingerprint: string
      thinking_level_map_json: string | null
    }
    expect(migratedMetadata.catalog_provider_id).toBe('openai')
    expect(migratedMetadata.source_fingerprint).not.toBe('')
    expect(JSON.parse(migratedMetadata.thinking_level_map_json!)).toEqual({
      max: null,
      xhigh: 'xhigh',
    })
    await service.setModelEnabled('openai-proxy', 'reasoner', true)
    await service.setModelParametersOverride('openai-proxy', 'reasoner', {
      contextWindow: 96_000,
      maxTokens: 12_000,
    })

    runtime.models = [{
      ...runtime.models[0]!,
      contextWindow: 256_000,
      maxTokens: 32_000,
      thinkingLevelMap: { high: 'high', max: 'max' },
    }]
    await service.refreshModelSnapshot()

    expect(await service.listModels('openai-proxy')).toEqual([
      expect.objectContaining({
        catalogMatch: 'matched',
        contextWindow: 96_000,
        enabled: true,
        maxTokens: 12_000,
        sourceContextWindow: 256_000,
        sourceMaxTokens: 32_000,
        sourceParametersUpdated: true,
      }),
    ])
    expect(runtime.registered.at(-1)).toMatchObject({
      config: {
        models: [{
          input: ['text', 'image'],
          thinkingLevelMap: { high: 'high', max: 'max' },
        }],
      },
      providerId: 'openai-proxy',
    })
    database.close()
  })

  it('persists a chosen metadata source without changing the route or user overrides and retains it when missing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-catalog-selection-'))
    databasePaths.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openBuddyDatabase({ databasePath })
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('first'), provider('second')]
    runtime.models = [
      model('first', 'shared'),
      { ...model('second', 'shared'), input: ['text', 'image'], reasoning: true, contextWindow: 256_000 },
    ]
    const options = {
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelDiscovery: createTestModelDiscovery(() => Promise.resolve([{ id: 'shared' }])),
      modelRuntime: runtime,
    }
    const service = createProviderServiceForTest({ ...options, providers: createProviderRepository(database) })
    await service.upsertCustomProvider({
      id: 'relay',
      displayName: 'Relay',
      api: 'openai-responses',
      baseUrl: 'https://relay.example.test/v1',
    })
    await service.syncModels('relay')
    expect((await service.listModels('relay'))[0]).toMatchObject({ catalogMatch: 'ambiguous', metadataKnown: false })
    await service.setModelEnabled('relay', 'shared', true)
    await service.setModelParametersOverride('relay', 'shared', { contextWindow: 96_000, maxTokens: 12_000 })
    const selection = { providerId: 'second', modelId: 'shared' }
    await service.setModelCatalogSource('relay', 'shared', selection)
    expect((await service.listModels('relay'))[0]).toMatchObject({
      catalog: { selection, source: selection },
      catalogMatch: 'matched',
      metadataKnown: true,
      enabled: true,
      contextWindow: 96_000,
      maxTokens: 12_000,
      sourceContextWindow: 256_000,
      capabilities: ['text', 'image', 'reasoning'],
    })
    expect(runtime.registered.at(-1)).toMatchObject({
      providerId: 'relay',
      config: { api: 'openai-responses', baseUrl: 'https://relay.example.test/v1', models: [{ id: 'shared' }] },
    })
    await expect(service.setModelCatalogSource('relay', 'shared', { providerId: 'first', modelId: 'other' }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })
    database.close()

    const reopened = openBuddyDatabase({ databasePath })
    const restored = createProviderServiceForTest({ ...options, providers: createProviderRepository(reopened) })
    runtime.models = runtime.models.filter(model => model.provider !== 'second')
    await restored.initializeProviders()
    expect((await restored.listModels('relay'))[0]).toMatchObject({
      catalog: { selection, source: selection },
      catalogMatch: 'unmatched',
      metadataKnown: true,
      enabled: true,
      contextWindow: 96_000,
      maxTokens: 12_000,
      sourceContextWindow: 256_000,
      capabilities: ['text', 'image', 'reasoning'],
    })
    await restored.setModelCatalogSource('relay', 'shared', null)
    expect((await restored.listModels('relay'))[0]).toMatchObject({
      catalog: { selection: null, source: { providerId: 'first' } },
      catalogMatch: 'matched',
      contextWindow: 96_000,
      maxTokens: 12_000,
    })
    reopened.close()
  })

  it('keeps capability overrides across model sync, snapshot refresh and restart, then restores current defaults', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-capabilities-'))
    databasePaths.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openBuddyDatabase({ databasePath })
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('origin')]
    runtime.models = [model('origin', 'shared')]
    const options = {
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelDiscovery: createTestModelDiscovery(() => Promise.resolve([{ id: 'shared' }])),
      modelRuntime: runtime,
    }
    const service = createProviderServiceForTest({ ...options, providers: createProviderRepository(database) })
    await service.upsertCustomProvider({
      id: 'relay',
      displayName: 'Relay',
      api: 'openai-responses',
      baseUrl: 'https://relay.example.test/v1',
    })
    await service.syncModels('relay')
    const capabilities = { image: true, pdf: true, reasoningOptions: ['high', 'max'] as const }
    runtime.models.push({ ...model('relay', 'shared'), baseUrl: 'https://relay.example.test/v1' })
    await service.setModelCapabilities('relay', 'shared', { ...capabilities, reasoningOptions: [...capabilities.reasoningOptions] })
    await service.setModelParametersOverride('relay', 'shared', { contextWindow: 64_000, maxTokens: 8_000 })
    await service.syncModels('relay')
    await service.refreshModelSnapshot()
    expect((await service.listModels('relay'))[0]).toMatchObject({
      capabilities: ['text', 'image', 'pdf', 'reasoning'],
      capabilityOverrides: capabilities,
      contextWindow: 64_000,
      maxTokens: 8_000,
    })
    database.close()

    const reopened = openBuddyDatabase({ databasePath })
    const restored = createProviderServiceForTest({ ...options, providers: createProviderRepository(reopened) })
    await restored.initializeProviders()
    const selection = { providerId: 'relay', modelId: 'shared', contextWindow: null, maxTokens: null }
    const effective = restored.executionModels.resolve(selection)
    expect(supportsModelPdfInput(effective)).toBe(true)
    expect(effective.input).toEqual(['text', 'image'])
    expect(getSupportedThinkingLevels(effective)).toEqual(['high', 'max'])
    await restored.setModelCapabilities('relay', 'shared', null)
    const defaults = restored.executionModels.resolve(selection)
    expect(supportsModelPdfInput(defaults)).toBe(false)
    expect(defaults.input).toEqual(['text'])
    expect(defaults.reasoning).toBe(false)
    expect(defaults.contextWindow).toBe(64_000)
    expect(defaults.maxTokens).toBe(8_000)
    expect((await restored.listModels('relay'))[0]?.capabilityOverrides).toBeNull()
    reopened.close()
  })

  it('keeps sparse overrides across restart while unedited capabilities follow snapshot changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-sparse-capabilities-'))
    databasePaths.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openBuddyDatabase({ databasePath })
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('origin')]
    runtime.models = [model('origin', 'shared')]
    const options = {
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelDiscovery: createTestModelDiscovery(() => Promise.resolve([{ id: 'shared' }])),
      modelRuntime: runtime,
    }
    try {
      const service = createProviderServiceForTest({ ...options, providers: createProviderRepository(database) })
      await service.upsertCustomProvider({ id: 'relay', displayName: 'Relay', api: 'openai-responses', baseUrl: 'https://relay.example.test/v1' })
      await service.syncModels('relay')
      await service.setModelCapabilities('relay', 'shared', { image: true })
      runtime.models[0] = { ...runtime.models[0]!, reasoning: true, thinkingLevelMap: { off: 'none', low: 'low', max: 'max' } }
      await service.refreshModelSnapshot()
      expect((await service.listModels('relay'))[0]).toMatchObject({
        capabilityOverrides: { image: true },
        capabilities: ['text', 'image', 'reasoning'],
        reasoningOptions: getSupportedThinkingLevels(runtime.models[0]),
      })
    }
    finally {
      database.close()
    }

    const reopened = openBuddyDatabase({ databasePath })
    try {
      const restored = createProviderServiceForTest({ ...options, providers: createProviderRepository(reopened) })
      await restored.initializeProviders()
      expect((await restored.listModels('relay'))[0]?.capabilityOverrides).toEqual({ image: true })
      await restored.setModelCapabilities('relay', 'shared', { reasoningOptions: ['high'] })
      runtime.models[0] = { ...runtime.models[0]!, input: ['text', 'image'] }
      await restored.refreshModelSnapshot()
      expect((await restored.listModels('relay'))[0]).toMatchObject({
        capabilityOverrides: { reasoningOptions: ['high'] },
        capabilities: ['text', 'image', 'reasoning'],
        reasoningOptions: ['high'],
      })
      expect((await restored.setModelCapabilities('relay', 'shared', {})).capabilityOverrides).toBeNull()
    }
    finally {
      reopened.close()
    }
  })

  it('separates disabling, clearing local authentication, and removing a provider while protecting active runs', async () => {
    const runtime = new FakeModelRuntime()
    runtime.providers = [provider('anthropic')]
    runtime.models = [model('anthropic', 'claude')]
    runtime.credentials = [{ providerId: 'anthropic', type: 'api_key' } as CredentialInfo]
    let activeRuns: Array<{ model: string, provider: string }> = [{
      model: 'claude',
      provider: 'anthropic',
    }]
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      getActiveRuns: () => activeRuns,
      modelRuntime: runtime,
      providers: createProviderRepository(database),
    })
    await restoreLegacyProvider(service, database, 'anthropic')
    await service.setModelEnabled('anthropic', 'claude', true)
    await service.setProviderEnabled('anthropic', true)

    await expect(service.setProviderEnabled('anthropic', false)).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    await expect(service.setModelEnabled('anthropic', 'claude', false)).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    await expect(service.setModelCapabilities('anthropic', 'claude', { image: true, reasoningOptions: ['high'] })).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    await expect(service.logout('anthropic')).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    await expect(service.clearCredential('anthropic')).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    await expect(service.removeProvider('anthropic')).rejects.toMatchObject({
      code: 'PROVIDER_HAS_ACTIVE_RUNS',
    })
    expect(runtime.credentials).toHaveLength(1)

    activeRuns = []
    await service.clearCredential('anthropic')
    expect(runtime.credentials).toEqual([])
    expect(await service.listProviders()).toEqual([
      expect.objectContaining({ added: true, setupComplete: false }),
    ])
    await service.removeProvider('anthropic')
    expect(await service.listProviders()).toEqual([])
    expect(service.listBuiltinPresets()).toContainEqual(expect.objectContaining({ id: 'anthropic' }))
    database.close()
  })

  it('does not re-register or refresh an existing custom provider while one of its runs is active', async () => {
    const runtime = new FakeModelRuntime()
    let activeRuns: Array<{ model: string, provider: string }> = []
    let syncCalls = 0
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      getActiveRuns: () => activeRuns,
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      modelDiscovery: createTestModelDiscovery(async () => {
        syncCalls += 1
        return []
      }),
    })
    await service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'https://old.example.test/v1',
      displayName: 'Custom provider',
      enabled: false,
      id: 'custom-provider',
      models: [],
    })
    activeRuns = [{ model: 'model-1', provider: 'custom-provider' }]

    await expect(service.upsertCustomProvider({
      api: 'openai-completions',
      baseUrl: 'https://new.example.test/v1',
      displayName: 'Changed provider',
      enabled: false,
      id: 'custom-provider',
      models: [],
    })).rejects.toMatchObject({ code: 'PROVIDER_HAS_ACTIVE_RUNS' })
    await expect(service.upsertManualModel('custom-provider', {
      id: 'manual-model',
      input: ['text'],
      reasoning: false,
    })).rejects.toMatchObject({ code: 'PROVIDER_HAS_ACTIVE_RUNS' })
    await expect(service.syncModels('custom-provider'))
      .rejects
      .toMatchObject({ code: 'PROVIDER_HAS_ACTIVE_RUNS' })
    expect(runtime.registered).toHaveLength(1)
    expect(syncCalls).toBe(0)
    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({
        api: 'openai-responses',
        baseUrl: 'https://old.example.test/v1',
      }),
    ])

    activeRuns = []
    await expect(service.upsertCustomProvider({
      api: 'openai-completions',
      baseUrl: 'https://new.example.test/v1',
      displayName: 'Changed provider',
      enabled: false,
      id: 'custom-provider',
      models: [],
    })).resolves.toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://new.example.test/v1',
    })
    expect(runtime.registered).toHaveLength(2)
    database.close()
  })

  it('syncs supported custom model catalogs while preserving manual overrides and explains unsupported APIs', async () => {
    const runtime = new FakeModelRuntime()
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      modelDiscovery: createTestModelDiscovery(async ({ providerId }) => providerId === 'openai-proxy'
        ? [{ id: 'manual-model', name: 'Remote name' }, { id: 'remote-model' }]
        : []),
    })
    await service.upsertCustomProvider({
      api: 'openai-responses',
      baseUrl: 'https://openai.example.test/v1',
      displayName: 'OpenAI Proxy',
      enabled: false,
      id: 'openai-proxy',
      models: [],
    })
    await service.upsertManualModel('openai-proxy', {
      id: 'manual-model',
      input: ['text'],
      name: 'Manual name',
      reasoning: false,
    })
    await service.setModelEnabled('openai-proxy', 'manual-model', false)
    await service.upsertManualModel('openai-proxy', {
      id: 'manual-model',
      input: ['text'],
      name: 'Updated manual name',
      reasoning: false,
    })
    expect(await service.listModels('openai-proxy')).toContainEqual(expect.objectContaining({
      displayName: 'Updated manual name',
      enabled: false,
      id: 'manual-model',
    }))
    await service.setModelEnabled('openai-proxy', 'manual-model', true)
    await service.syncModels('openai-proxy')
    expect(await service.listModels('openai-proxy')).toEqual([
      expect.objectContaining({ displayName: 'Updated manual name', enabled: true, source: 'manual' }),
      expect.objectContaining({ id: 'remote-model', enabled: false, source: 'synced' }),
    ])

    await service.upsertCustomProvider({
      api: 'anthropic-messages',
      baseUrl: 'https://anthropic.example.test',
      displayName: 'Anthropic Proxy',
      enabled: false,
      id: 'anthropic-proxy',
      models: [],
    })
    expect(await service.listProviders()).toContainEqual(expect.objectContaining({
      canSyncModels: false,
      id: 'anthropic-proxy',
      syncUnavailableReason: 'unsupported_api',
    }))
    await expect(service.syncModels('anthropic-proxy')).rejects.toMatchObject({
      code: 'MODEL_SYNC_UNSUPPORTED',
    })
    database.close()
  })

  it('clears only models that left the synced catalog and releases their default selection', async () => {
    const runtime = new FakeModelRuntime()
    let definitions = [{ id: 'current-model' }, { id: 'retired-model' }]
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = createProviderServiceForTest({
      authInteractions: new AuthInteractionService({ notify: () => {} }),
      modelRuntime: runtime,
      providers: createProviderRepository(database),
      modelDiscovery: createTestModelDiscovery(async () => definitions),
    })
    await service.upsertCustomProvider({
      api: 'openai-completions',
      baseUrl: 'https://relay.example.test/v1',
      displayName: 'Relay',
      enabled: true,
      id: 'relay',
      models: [],
    })
    runtime.credentials = [{ providerId: 'relay', type: 'api_key' } as CredentialInfo]
    runtime.models = [model('relay', 'retired-model')]
    await service.syncModels('relay')
    await service.setModelEnabled('relay', 'retired-model', true)
    await service.setDefaultModel({ modelId: 'retired-model', providerId: 'relay', reasoning: null })

    definitions = [{ id: 'current-model' }]
    await service.syncModels('relay')
    expect(await service.listModels('relay')).toEqual([
      expect.objectContaining({ available: true, id: 'current-model' }),
      expect.objectContaining({ available: false, id: 'retired-model' }),
    ])

    await expect(service.removeModel('relay', 'current-model')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
    expect(await service.getDefaultModel()).toMatchObject({ modelId: 'retired-model' })

    await service.removeModel('relay', 'retired-model')
    expect(await service.listModels('relay')).toEqual([
      expect.objectContaining({ id: 'current-model' }),
    ])
    expect(await service.getDefaultModel()).toBeNull()
    await expect(service.removeModel('relay', 'retired-model')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
    database.close()
  })
})

type ProviderServiceTestOptions
  = Omit<ProviderServiceOptions, 'credentialStatus' | 'modelDiscovery' | 'modelRuntime'>
    & {
      modelDiscovery?: ProviderModelDiscovery
      modelRuntime: FakeModelRuntime
    }

function createProviderServiceForTest(options: ProviderServiceTestOptions): ProviderService {
  const {
    modelDiscovery = createTestModelDiscovery(),
    modelRuntime,
    ...serviceOptions
  } = options
  const providerIds = modelRuntime.getProviders().map(provider => provider.id)
  const status = async () => ({ checkedAt: null, errorCount: 0, generatedAt: null, lastAttemptAt: null, modelCount: modelRuntime.models.length, providerCount: providerIds.length, source: 'builtin' as const, updatedAt: null })
  return new ProviderService({
    ...serviceOptions,
    modelSnapshot: serviceOptions.modelSnapshot ?? {
      initialize: async () => {},
      getModels: providerId => modelRuntime.getModels(providerId).filter(model => providerIds.includes(model.provider)),
      getProviders: () => modelRuntime.getProviders().filter(provider => providerIds.includes(provider.id)),
      getStatus: status,
      refresh: status,
    },
    credentialStatus: createProviderCredentialStatus({
      list: () => modelRuntime.listCredentials(),
    }),
    modelDiscovery,
    modelRuntime,
  })
}

function createTestModelDiscovery(
  discover: ProviderModelDiscovery['discover'] = () => Promise.resolve([]),
): ProviderModelDiscovery {
  return {
    discover,
    supports: api => api === 'openai-completions' || api === 'openai-responses',
  }
}

function provider(id: string): Provider {
  return {
    auth: { apiKey: {} },
    baseUrl: `https://api.${id}.test`,
    id,
    name: id,
  } as Provider
}

function model(providerId: string, id: string): Model<Api> {
  return {
    api: 'openai-responses',
    baseUrl: `https://api.${providerId}.test`,
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ['text'],
    maxTokens: 16_384,
    name: id,
    provider: providerId,
    reasoning: false,
  } as Model<Api>
}

async function restoreLegacyProvider(service: ProviderService, database: DatabaseSync, providerId: string) {
  const now = new Date().toISOString()
  createProviderRepository(database).states.upsert({ providerId, enabled: false, createdAt: now, updatedAt: now })
  await service.initializeProviders()
}

class FakeModelRuntime {
  registerNativeProvider(provider: Provider): void {
    this.providers.push(provider)
  }

  readonly registered: Array<{ config: unknown, providerId: string }> = []
  credentialsError: Error | null = null
  credentials: CredentialInfo[] = []
  loginResult: string | null = null
  providers: Provider[] = []
  models: Model<Api>[] = []
  readonly refreshCalls: unknown[] = []

  refresh(options?: unknown): Promise<Awaited<ReturnType<ModelRuntime['refresh']>>> {
    this.refreshCalls.push(options)
    return Promise.resolve({ aborted: false, errors: new Map() })
  }

  getAuth(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    return providerId ? this.models.filter(model => model.provider === providerId) : this.models
  }

  async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    return this.getModels(providerId)
  }

  getProvider(providerId: string): Provider | undefined {
    if (providerId === 'openai-codex')
      return { auth: { oauth: {} }, id: providerId } as Provider
    return this.providers.find(provider => provider.id === providerId)
  }

  getProviders(): readonly Provider[] {
    return this.providers
  }

  listCredentials(): Promise<readonly CredentialInfo[]> {
    if (this.credentialsError)
      return Promise.reject(this.credentialsError)
    return Promise.resolve(this.credentials)
  }

  async login(_providerId: string, _type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize' })
    this.loginResult = await interaction.prompt({
      message: 'Paste the authorization code',
      type: 'manual_code',
    })
    return { type: 'api_key', key: this.loginResult }
  }

  logout(providerId: string): Promise<void> {
    this.credentials = this.credentials.filter(credential => credential.providerId !== providerId)
    return Promise.resolve()
  }

  registerProvider(providerId: string, config: unknown): void {
    this.registered.push({ config, providerId })
  }

  unregisterProvider(): void {}
}
