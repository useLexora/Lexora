import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderModelDiscoveryResult } from '../ProviderModelDiscovery'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { createProviderResolutionRepository } from '../../storage/providerResolutionRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { ProviderCatalogMatcher } from '../ProviderCatalogMatcher'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { ProviderService } from '../ProviderService'

const connection = { id: 'resolution-fixture', api: 'openai-completions' as const, baseUrl: 'https://relay.example.test/v1', displayName: 'Resolution fixture' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function metadata(context = 128_000, image = true) {
  return {
    first: { name: 'First', api: 'https://first.example.test/v1', models: {
      shared: { name: 'First model', modalities: { input: image ? ['text', 'image', 'pdf'] : ['text'], output: ['text'] }, limit: { context, output: 8192 }, tool_call: false },
    } },
    second: { name: 'Second', api: 'https://second.example.test/v1', models: {
      shared: { name: 'Second model', modalities: { input: ['text'], output: ['text'] }, limit: { context: 64_000, output: 4096 }, tool_call: true },
    } },
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-provider-resolution-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'buddy.sqlite')
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(connection.id, async () => ({ type: 'api_key', key: 'fixture-only-key' }))
  let data = metadata()
  let discover = async (): Promise<ProviderModelDiscoveryResult> => ({ models: [{ id: 'shared' }], complete: true })
  const open = async (builtin = false) => {
    const database = openBuddyDatabase({ databasePath })
    const repositories = createProviderRepository(database)
    const checkpoints = createProviderResolutionRepository(database)
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
    if (builtin) {
      const model: Model<Api> = { id: 'native-model', name: 'Native model', api: 'openai-completions', provider: 'fixture-native', baseUrl: 'https://native.example.test', contextWindow: 32_000, maxTokens: 4096, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      runtime.registerProvider('fixture-native', { api: model.api, baseUrl: model.baseUrl, name: 'Native', models: [model] })
      if (!repositories.builtins.findById('fixture-native'))
        repositories.builtins.upsert({ id: 'fixture-native', builtinProviderId: 'fixture-native', displayName: null, createdAt: 'fixture-created', updatedAt: 'fixture-created' })
    }
    const snapshot = new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data }, fetch: async () => Response.json(data) })
    const service = new ProviderService({
      authInteractions: new AuthInteractionService(),
      credentialStatus: createProviderCredentialStatus(credentials),
      modelRuntime: runtime,
      providers: repositories,
      resolutionRepository: checkpoints,
      modelSnapshot: snapshot,
      modelDiscovery: { supports: () => true, discover: () => discover() },
    })
    const resolutions: Array<{ providerId: string, restored: boolean }> = []
    service.onDidResolve(event => resolutions.push(event))
    let closed = false
    const close = async () => {
      if (closed)
        return
      closed = true
      await service.dispose()
      database.close()
    }
    cleanups.push(close)
    await service.initializeProviders()
    return { service, database, repositories, checkpoints, resolutions, close }
  }
  return {
    open,
    setMetadata(next: ReturnType<typeof metadata>) {
      data = next
    },
    setDiscovery(next: typeof discover) {
      discover = next
    },
  }
}

describe('durable provider resolution', () => {
  it('reopens SQLite and restores committed capabilities, selection and user settings without re-resolving or writing model rows', async () => {
    const f = await fixture()
    const first = await f.open(true)
    await first.service.createCustomProvider(connection)
    await first.service.syncModels(connection.id)
    await first.service.setModelCatalogSource(connection.id, 'shared', { providerId: 'first', modelId: 'shared' })
    await first.service.setModelEnabled(connection.id, 'shared', true)
    await first.service.setProviderEnabled(connection.id, true)
    await first.service.setModelCapabilities(connection.id, 'shared', { image: false })
    await first.service.setModelParametersOverride(connection.id, 'shared', { contextWindow: 16_000, maxTokens: 2048 })
    await first.service.setDefaultModel({ providerId: connection.id, modelId: 'shared', reasoning: 'off' })
    const before = first.repositories.models.list()
    const displayed = await first.service.listModels(connection.id)
    const resolved = first.service.executionModels.resolve({ providerId: connection.id, modelId: 'shared', contextWindow: null, maxTokens: null })
    expect(resolved).toMatchObject({ id: 'shared', input: ['text'], toolCall: false, contextWindow: 16_000, maxTokens: 2048 })
    expect(before.find(model => model.providerId === connection.id)?.resolution).toMatchObject({ version: 1, catalogMatch: 'matched' })
    expect(JSON.stringify(before)).not.toContain('fixture-only-key')
    await first.close()
    const matching = vi.spyOn(ProviderCatalogMatcher.prototype, 'match')
    const second = await f.open(true)
    expect(second.repositories.models.list()).toEqual(before)
    expect(await second.service.listModels(connection.id)).toEqual(displayed)
    expect(second.service.executionModels.resolve({ providerId: connection.id, modelId: 'shared', contextWindow: null, maxTokens: null })).toEqual(resolved)
    expect(await second.service.getDefaultModel()).toMatchObject({ modelId: 'shared', reasoning: 'off' })
    expect(second.resolutions.filter(event => event.restored).map(event => event.providerId)).toEqual(expect.arrayContaining([connection.id, 'fixture-native']))
    expect(matching).not.toHaveBeenCalled()
    second.checkpoints.remove('fixture-native')
    await second.close()
    const third = await f.open(true)
    expect(third.resolutions).toContainEqual({ providerId: 'fixture-native', restored: false })
    expect(third.repositories.models.list()).toEqual(before)
  })

  it('invalidates changed catalog contents, connection, explicit source and resolution rules without losing overrides', async () => {
    const f = await fixture()
    let current = await f.open()
    await current.service.createCustomProvider(connection)
    await current.service.syncModels(connection.id)
    await current.service.setModelCatalogSource(connection.id, 'shared', { providerId: 'first', modelId: 'shared' })
    await current.service.setModelParametersOverride(connection.id, 'shared', { contextWindow: 16_000, maxTokens: 2048 })
    const originalRevision = current.repositories.models.find(connection.id, 'shared')!.sourceRevision
    await current.close()
    f.setMetadata(metadata(256_000, false))
    current = await f.open()
    expect(current.resolutions).toContainEqual({ providerId: connection.id, restored: false })
    expect(current.repositories.models.find(connection.id, 'shared')).toMatchObject({ sourceContextWindow: 256_000, overrideContextWindow: 16_000, input: ['text'] })
    expect(current.repositories.models.find(connection.id, 'shared')!.sourceRevision).not.toBe(originalRevision)
    await current.service.setModelCatalogSource(connection.id, 'shared', { providerId: 'second', modelId: 'shared' })
    expect((await current.service.listModels(connection.id))[0]).toMatchObject({ sourceContextWindow: 64_000, contextWindow: 16_000 })
    await current.service.upsertCustomProvider({ ...connection, baseUrl: 'https://other.example.test/v1', api: 'anthropic-messages', models: [] })
    expect(current.service.executionModels.resolve({ providerId: connection.id, modelId: 'shared', contextWindow: null, maxTokens: null })).toMatchObject({ baseUrl: 'https://other.example.test/v1', api: 'anthropic-messages', contextWindow: 16_000 })
    current.database.prepare('UPDATE provider_resolution_checkpoints SET input_fingerprint = ? WHERE provider_id = ?').run('old-resolution-rules', connection.id)
    await current.close()
    current = await f.open()
    expect(current.resolutions).toContainEqual({ providerId: connection.id, restored: false })
    const state = current.repositories.models.find(connection.id, 'shared')!
    current.database.prepare('UPDATE provider_model_states SET resolution_json = ? WHERE provider_id = ?').run(JSON.stringify({ ...state.resolution, version: 0 }), connection.id)
    expect(current.checkpoints.find(connection.id)).toBeNull()
    await current.close()
    current = await f.open()
    expect(current.repositories.models.find(connection.id, 'shared')?.resolution?.version).toBe(1)
    expect((await current.service.listModels(connection.id))[0]).toMatchObject({ contextWindow: 16_000, sourceContextWindow: 64_000 })
  })

  it('does not commit a discovery result after shutdown has begun', async () => {
    const f = await fixture()
    const current = await f.open()
    await current.service.createCustomProvider(connection)
    const before = current.repositories.models.list()
    const checkpoint = current.checkpoints.find(connection.id)
    const pending = Promise.withResolvers<ProviderModelDiscoveryResult>()
    const started = Promise.withResolvers<void>()
    f.setDiscovery(async () => {
      started.resolve()
      return pending.promise
    })
    const discovery = current.service.syncModels(connection.id)
    const rejected = expect(discovery).rejects.toThrow()
    await started.promise
    const disposing = current.service.dispose()
    pending.resolve({ models: [{ id: 'late-model' }], complete: true })
    await rejected
    await disposing
    expect(current.repositories.models.list()).toEqual(before)
    expect(current.checkpoints.find(connection.id)).toBe(checkpoint)
  })

  it('keeps the newest discovered declaration when an older response arrives late', async () => {
    const f = await fixture()
    const current = await f.open()
    await current.service.createCustomProvider(connection)
    const pending = Promise.withResolvers<ProviderModelDiscoveryResult>()
    const started = Promise.withResolvers<void>()
    f.setDiscovery(async () => {
      started.resolve()
      return pending.promise
    })
    const older = current.service.syncModels(connection.id)
    const rejected = expect(older).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    await started.promise
    f.setDiscovery(async () => ({ complete: false, models: [{ id: 'shared', metadata: { contextWindow: 96_000, maxTokens: 4096, input: ['text'] } }] }))
    await current.service.syncModels(connection.id)
    pending.resolve({ complete: true, models: [{ id: 'shared', metadata: { contextWindow: 8192, maxTokens: 2048, input: ['text', 'image'] } }] })
    await rejected
    expect(current.repositories.models.find(connection.id, 'shared')).toMatchObject({ sourceContextWindow: 96_000, input: ['text'] })
    expect((await current.service.listModels(connection.id))[0]).toMatchObject({ contextWindow: 96_000, capabilities: ['text'] })
  })
})
