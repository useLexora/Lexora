import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionChatEvent, ExtensionChatRequest, ExtensionModel } from '../../../../shared/extensions/extensionChat'
import type { ProviderServiceOptions } from '../ProviderService'
import type { ProviderCommit } from '../ProviderState'
import { randomUUID } from 'node:crypto'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, onTestFinished } from 'vitest'
import { registerExtensionImageReadingRpc } from '../../../../electron/main/extensions/registerExtensionImageReadingRpc'
import { registerExtensionImageRpc } from '../../../../electron/main/extensions/registerExtensionImageRpc'
import { registerExtensionModelRpc } from '../../../../electron/main/extensions/registerExtensionModelRpc'
import { extensionChatRequestSchema, extensionChatRpc, pluginChatApi } from '../../../../shared/extensions/extensionChat'
import { providersRpc } from '../../../../shared/providers/providerApi'
import { isChatModel } from '../../../../shared/providers/providerModelType'
import { inferenceHost, pngBytes, readInferenceJson, rpcPair } from '../../images/__tests__/pluginImageFixtures'
import { createPluginImageBackends } from '../../images/createPluginImageBackends'
import { PluginImageGateway } from '../../images/PluginImageGateway'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderRepository } from '../../storage/providerRepository'
import { AuthInteractionService } from '../AuthInteractionService'
import { createProviderModelRuntime } from '../createProviderModelRuntime'
import { PluginModelRegistry } from '../PluginModelRegistry'
import { createProviderCredentialStatus } from '../ProviderCredentialStatus'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'
import { ProviderRequestHeaders } from '../ProviderRequestHeaders'
import { ProviderService } from '../ProviderService'
import { registerProviderCatalogRpc, registerProviderRpc } from '../registerProviderRpc'

const descriptor: ExtensionModel = {
  id: 'local-vision',
  title: 'Local vision',
  capability: 'chat',
  input: ['text', 'image'],
  tools: false,
  contextWindow: 8192,
  maxTokens: 512,
  extensionId: 'fixture.local',
  extensionName: 'Local models',
  generation: randomUUID(),
  revision: 'a'.repeat(64),
  bindingRevision: 'b'.repeat(64),
  managementPage: true,
}
const providerId = `plugin:${descriptor.extensionId}`
const selected = { providerId, modelId: descriptor.id, reasoning: null }
const selection = { ...selected, contextWindow: null, maxTokens: null }

async function fixture(modelSnapshot?: ProviderServiceOptions['modelSnapshot'], getActiveRuns: ProviderServiceOptions['getActiveRuns'] = () => []) {
  const peers = rpcPair()
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createProviderRepository(database)
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  const registration = createProviderModelRuntime(runtime, new ProviderRequestHeaders(repository.states))
  const status = async () => ({ checkedAt: null, errorCount: 0, generatedAt: null, lastAttemptAt: null, modelCount: 0, providerCount: 0, source: 'builtin' as const, updatedAt: null })
  const createService = (modelRuntime = registration, sessionRuntime = runtime) => new ProviderService({
    authInteractions: new AuthInteractionService(),
    credentialStatus: createProviderCredentialStatus({ list: async () => [] }),
    getActiveRuns,
    modelDiscovery: { discover: async () => ({ models: [], complete: true }), supports: () => false },
    modelRuntime,
    sessionRuntime,
    providers: repository,
    modelSnapshot: modelSnapshot ?? { initialize: async () => {}, getModels: () => [], getProviders: () => [], getStatus: status, refresh: status },
  })
  const service = createService()
  const services = [service]
  await service.initializeProviders()
  let models = [descriptor]
  let listFailure = false
  const inference = inferenceHost(async () => {
    throw new Error('Inference is not part of catalog discovery')
  })
  inference.models = async () => {
    if (listFailure)
      throw new Error('Catalog unavailable')
    return models
  }
  const registry = new PluginModelRegistry(peers.service, service, () => {})
  const registries = [registry]
  const disposers = [
    registerExtensionImageReadingRpc(peers.host, () => inference),
    registerExtensionImageRpc(peers.host, () => inference),
    registerExtensionModelRpc(peers.host, () => inference),
    registerProviderCatalogRpc({ rpc: peers.service, service, refreshCapabilities: () => registry.refresh() }),
    registerProviderRpc({ rpc: peers.service, service, refreshCapabilities: () => registry.refresh() }),
  ]
  const gateway = new PluginImageGateway(peers.service)
  const { reading, generation } = createPluginImageBackends(peers.service, service, gateway)
  onTestFinished(async () => {
    for (const current of registries)
      await current.dispose()
    gateway.dispose()
    disposers.forEach(dispose => dispose())
    for (const current of services)
      await current.dispose()
    database.close()
  })
  return {
    peers,
    service,
    repository,
    registry,
    runtime,
    inference,
    reading,
    generation,
    restart: async () => {
      await registry.dispose()
      const nextRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
      const nextRegistration = createProviderModelRuntime(nextRuntime, new ProviderRequestHeaders(repository.states))
      const next = createService(nextRegistration, nextRuntime)
      services.push(next)
      await next.initializeProviders()
      const nextRegistry = new PluginModelRegistry(peers.service, next, () => {})
      registries.push(nextRegistry)
      return { service: next, registry: nextRegistry }
    },
    setModels: (value: ExtensionModel[]) => { models = value },
    failListing: () => { listFailure = true },
  }
}

const qwen = { providerId: 'huggingface', modelId: 'Qwen/Qwen3.5-9B' }
const base = { ...qwen, modelId: 'Qwen/Qwen3.5-9B-Base' }

function catalogData(supported: boolean | undefined, reasoning?: boolean) {
  return { huggingface: { name: 'Hugging Face', models: {
    [qwen.modelId]: { name: 'Qwen3.5 9B', type: 'chat', modalities: { input: ['text', 'image/png', 'application/pdf', 'audio/wav', 'video/mp4'], output: ['text'] }, limit: { context: 262144, output: 8192 }, capabilities: { tools: { supported }, reasoning: { supported: reasoning, effort: ['none', 'low', 'high'] } } },
  } } }
}

describe('plugin model registry', () => {
  it('merges plugin metadata by field without requiring HF identity and caps capabilities to the loaded backend', async () => {
    const data = { vendor: catalogData(true, true).huggingface }
    const f = await fixture(new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data } }))
    const reference = { providerId: 'vendor', modelId: qwen.modelId }
    const cases: Array<{ model: ExtensionModel, tools: boolean, reasoning: boolean, contextWindow: number, maxTokens: number }> = [
      { model: { ...descriptor, id: 'local', reasoning: false, metadata: { toolCall: true, reasoningOptions: ['off', 'medium', 'high', 'future'], input: ['text'], contextWindow: 262144, maxTokens: 8192 } }, tools: true, reasoning: true, contextWindow: 8192, maxTokens: 512 },
      { model: { ...descriptor, id: 'explicit-false', tools: true, reasoning: true, catalogModels: [reference], metadata: { toolCall: false, reasoningOptions: [], input: ['text'] } }, tools: false, reasoning: false, contextWindow: 8192, maxTokens: 512 },
      { model: { ...descriptor, id: 'sparse', tools: 'auto', reasoning: 'auto', catalogModels: [reference], metadata: { input: ['text'] } }, tools: true, reasoning: true, contextWindow: 8192, maxTokens: 512 },
      { model: { ...descriptor, id: 'unsupported-effort', metadata: { input: ['text'], reasoningOptions: ['high'] } }, tools: false, reasoning: false, contextWindow: 8192, maxTokens: 512 },
      { model: { ...descriptor, id: 'smaller-budget', metadata: { input: ['text'], contextWindow: 4096, maxTokens: 128 } }, tools: false, reasoning: false, contextWindow: 4096, maxTokens: 128 },
      { model: { ...descriptor, id: 'unsupported-inputs', metadata: { input: ['text', 'pdf', 'audio', 'video'] } }, tools: false, reasoning: false, contextWindow: 8192, maxTokens: 512 },
    ]
    f.setModels(cases.map(item => item.model))
    await f.registry.refresh()
    const listed = await f.service.listModels(providerId)
    for (const { model, tools, reasoning, contextWindow, maxTokens } of cases) {
      const effective = await f.service.executionModels.resolveAvailable({ ...selection, modelId: model.id })
      expect(effective).toMatchObject({ id: model.id, provider: providerId, toolCall: tools, reasoning, input: ['text'], contextWindow, maxTokens })
      expect(listed.find(item => item.id === model.id)).toMatchObject({ toolCalling: tools, capabilities: reasoning ? ['text', 'reasoning'] : ['text'], reasoningOptions: reasoning ? ['off', 'medium'] : [], contextWindow, maxTokens, sourceCapabilities: { toolCall: tools, image: false, pdf: false, audio: false, video: false } })
    }
    await expect(f.service.executionModels.resolveAvailable({ ...selection, modelId: 'local', contextWindow: 262144, maxTokens: 8192 })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })

  it('preserves metadata bindings, sparse overrides and an off selection across rebinding, failure and restart', async () => {
    const f = await fixture()
    const bound: ExtensionModel = { ...descriptor, metadata: { toolCall: true, reasoningOptions: ['off', 'medium'], input: ['text'] } }
    f.setModels([bound])
    await f.registry.refresh()
    const off = { ...selected, reasoning: 'off' as const }
    await f.service.setDefaultModel(off)
    const overrides = { toolCall: false, reasoningOptions: ['off', 'medium', 'high'] as ('off' | 'medium' | 'high')[] }
    await f.service.setModelCapabilities(providerId, descriptor.id, overrides)
    const updated: ExtensionModel = { ...bound, bindingRevision: 'c'.repeat(64), metadata: { toolCall: false, reasoningOptions: [], input: ['text', 'image'] } }
    f.setModels([updated])
    await f.registry.refresh()
    const restarted = await f.restart()
    await restarted.registry.refresh()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ capabilityOverrides: overrides, toolCalling: false, capabilities: ['text', 'image', 'reasoning'], reasoningOptions: ['off', 'medium'], sourceCapabilities: { toolCall: false, reasoningOptions: ['off'] } }])
    expect(await restarted.service.executionModels.resolveAvailable(selection)).toMatchObject({ toolCall: false, reasoning: true, thinkingLevelMap: { low: null, high: null }, contextWindow: descriptor.contextWindow, maxTokens: descriptor.maxTokens })
    expect(await restarted.service.getDefaultModel()).toEqual(off)
    f.failListing()
    await expect(restarted.registry.refresh()).rejects.toThrow()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ capabilityOverrides: overrides, reasoningOptions: ['off', 'medium'] }])
    await restarted.service.setModelCapabilities(providerId, descriptor.id, { toolCall: true })
    expect(await restarted.service.executionModels.resolveAvailable(selection)).toMatchObject({ toolCall: true, reasoning: false })
    expect(await restarted.service.getDefaultModel()).toEqual(off)
  })

  it('uses exact bundled Qwen sources without interpreting GGUF names or overriding boolean declarations', async () => {
    const f = await fixture(new ProviderModelSnapshotService())
    const cases = [
      { id: 'qwen', tools: 'auto', catalogModels: [qwen], expected: true },
      { id: 'base', tools: 'auto', catalogModels: [base], expected: false },
      { id: 'qwen3.5-9b-gguf', tools: 'auto', expected: false },
      { id: 'unknown', tools: 'auto', catalogModels: [{ ...qwen, modelId: 'Qwen/Qwen3.5-9B-GGUF' }], expected: false },
      { id: 'mixed', tools: 'auto', catalogModels: [qwen, base], expected: true },
      { id: 'unknown-mixed', tools: 'auto', catalogModels: [qwen, { ...qwen, modelId: 'unknown' }], expected: true },
      { id: 'explicit-off', tools: false, catalogModels: [qwen], expected: false },
      { id: 'legacy-on', tools: true, expected: true },
      { id: 'legacy-off', tools: false, expected: false },
      { id: 'explicit-on', tools: true, catalogModels: [base], expected: true },
    ] as const
    f.setModels(cases.map(({ expected: _expected, ...model }) => ({ ...descriptor, ...model, catalogModels: 'catalogModels' in model ? [...model.catalogModels] : undefined })))
    await f.registry.refresh()
    const models = await f.service.listModels(providerId)
    for (const model of cases) {
      expect(models.find(candidate => candidate.id === model.id), model.id).toMatchObject({ toolCalling: model.expected, capabilities: ['text', 'image'], contextWindow: descriptor.contextWindow, maxTokens: descriptor.maxTokens })
      expect(await f.service.executionModels.resolveAvailable({ ...selection, modelId: model.id })).toMatchObject({ id: model.id, provider: providerId, toolCall: model.expected })
    }
  })

  it('resolves reasoning from explicit declarations or consistent known catalog references without opting legacy models in', async () => {
    const data = catalogData(true, true)
    const alias = { ...qwen, modelId: 'Qwen/Qwen3.5-9B-Alias' }
    data.huggingface.models[alias.modelId] = { ...data.huggingface.models[qwen.modelId]! }
    data.huggingface.models[base.modelId] = { ...data.huggingface.models[qwen.modelId]!, capabilities: { tools: { supported: true }, reasoning: { supported: false, effort: [] } } }
    const f = await fixture(new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data } }))
    const cases = [
      { id: 'explicit-on', reasoning: true, catalogModels: [base], expected: true },
      { id: 'explicit-on-no-reference', reasoning: true, expected: true },
      { id: 'explicit-off', reasoning: false, catalogModels: [qwen], expected: false },
      { id: 'automatic', reasoning: 'auto', catalogModels: [qwen], expected: true },
      { id: 'unanimous', reasoning: 'auto', catalogModels: [qwen, alias], expected: true },
      { id: 'conflict', reasoning: 'auto', catalogModels: [qwen, base], expected: false },
      { id: 'unknown', reasoning: 'auto', catalogModels: [{ ...qwen, modelId: 'unknown' }], expected: false },
      { id: 'unknown-mixed', reasoning: 'auto', catalogModels: [qwen, { ...qwen, modelId: 'unknown' }], expected: true },
      { id: 'wrong-provider', reasoning: 'auto', catalogModels: [{ ...qwen, providerId: 'unknown' }], expected: false },
      { id: 'qwen3.5-9b-gguf', reasoning: 'auto', expected: false },
      { id: 'legacy', expected: false },
      { id: 'legacy-with-reference', catalogModels: [qwen], expected: false },
    ] as const
    f.setModels(cases.map(({ expected: _expected, ...model }) => ({ ...descriptor, ...model, catalogModels: 'catalogModels' in model ? [...model.catalogModels] : undefined })))
    await f.registry.refresh()
    const models = await f.service.listModels(providerId)
    for (const { id, expected } of cases) {
      const reasoningOptions = expected ? ['off', 'medium'] : ['off']
      expect(models.find(model => model.id === id)).toMatchObject({ capabilities: expected ? ['text', 'image', 'reasoning'] : ['text', 'image'], reasoningOptions: expected ? reasoningOptions : [], sourceCapabilities: { reasoningOptions }, contextWindow: descriptor.contextWindow, maxTokens: descriptor.maxTokens })
      const runtime = await f.service.executionModels.resolveAvailable({ ...selection, modelId: id })
      expect(runtime).toMatchObject({ reasoning: expected })
      if (expected)
        expect(runtime.thinkingLevelMap).toMatchObject({ minimal: null, low: null, high: null, xhigh: null, max: null })
      expect(f.repository.models.find(providerId, id)).toMatchObject({ reasoning: expected, thinkingLevelMap: runtime.thinkingLevelMap ?? null })
    }
    expect(f.service.resolvePluginModel({ ...descriptor, reasoning: 'auto', catalogModels: [] }).reasoning).toBe(false)
  })

  it('re-registers reasoning-only catalog changes and persists source maps without losing overrides or active selections', async () => {
    let data = catalogData(true)
    let active = false
    const snapshot = new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data }, fetch: async () => Response.json(data) })
    const f = await fixture(snapshot, () => active ? [{ provider: providerId, model: descriptor.id }] : [])
    const automatic: ExtensionModel = { ...descriptor, tools: 'auto', reasoning: 'auto', catalogModels: [qwen] }
    f.setModels([automatic, { ...automatic, id: 'disabled' }, { ...automatic, id: 'overridden' }, { ...automatic, id: 'explicit-off', reasoning: false }, { ...descriptor, id: 'legacy', catalogModels: [qwen] }])
    await f.registry.refresh()
    await f.service.setDefaultModel(selected)
    await f.service.setModelEnabled(providerId, 'disabled', false)
    const overrides = { reasoningOptions: ['off'] as const, image: false, toolCall: false }
    await f.service.setModelCapabilities(providerId, 'overridden', { ...overrides, reasoningOptions: [...overrides.reasoningOptions] })
    const before = f.repository.models.find(providerId, descriptor.id)!
    const inFlight = await f.service.executionModels.resolveAvailable(selection)
    active = true
    for (const supported of [true, false, true]) {
      data = catalogData(true, supported)
      await f.service.refreshModelSnapshot()
      await f.registry.refresh()
      const reasoningOptions = supported ? ['off', 'medium'] : ['off']
      expect(await f.service.listModels(providerId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: descriptor.id, toolCalling: true, reasoningOptions: supported ? reasoningOptions : [], enabled: true }),
        expect.objectContaining({ id: 'disabled', reasoningOptions: supported ? reasoningOptions : [], enabled: false }),
        expect.objectContaining({ id: 'overridden', reasoningOptions: [], capabilityOverrides: overrides, sourceCapabilities: expect.objectContaining({ reasoningOptions }) }),
        expect.objectContaining({ id: 'explicit-off', reasoningOptions: [] }),
        expect.objectContaining({ id: 'legacy', reasoningOptions: [] }),
      ]))
      const runtime = await f.service.executionModels.resolveAvailable(selection)
      expect(runtime).toMatchObject({ reasoning: supported, toolCall: true, contextWindow: descriptor.contextWindow, maxTokens: descriptor.maxTokens })
      expect(f.repository.models.find(providerId, descriptor.id)).toMatchObject({ providerId, modelId: descriptor.id, createdAt: before.createdAt, reasoning: supported, thinkingLevelMap: runtime.thinkingLevelMap ?? null })
      expect(f.repository.models.find(providerId, 'overridden')).toMatchObject({ reasoning: supported, thinkingLevelMap: runtime.thinkingLevelMap ?? null, capabilityOverrides: overrides })
      expect(await f.service.getDefaultModel()).toEqual(selected)
      expect(await f.service.listProviders()).toMatchObject([{ id: providerId, enabled: true, activeRunCount: 1 }])
      expect(inFlight.reasoning).toBe(false)
    }
    await expect(f.service.setModelEnabled(providerId, descriptor.id, false)).rejects.toThrow()
    await expect(f.service.setProviderEnabled(providerId, false)).rejects.toThrow()
    active = false
    const restarted = await f.restart()
    await restarted.registry.refresh()
    expect(await restarted.service.listModels(providerId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: descriptor.id, reasoningOptions: ['off', 'medium'] }),
      expect.objectContaining({ id: 'disabled', enabled: false }),
      expect.objectContaining({ id: 'overridden', reasoningOptions: [], capabilityOverrides: overrides, sourceCapabilities: expect.objectContaining({ reasoningOptions: ['off', 'medium'] }) }),
    ]))
    expect(await restarted.service.getDefaultModel()).toEqual(selected)
  })

  it('recomputes automatic tools on accepted catalog updates while retaining raw binding, budgets and user selections', async () => {
    let data = catalogData(undefined)
    const snapshot = new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data }, fetch: async () => Response.json(data) })
    const f = await fixture(snapshot)
    const automatic = { ...descriptor, tools: 'auto' as const, catalogModels: [qwen] }
    f.setModels([automatic, { ...automatic, id: 'disabled' }, { ...automatic, id: 'explicit-off', tools: false }])
    await f.registry.refresh()
    await f.service.setDefaultModel(selected)
    await f.service.setModelEnabled(providerId, 'disabled', false)
    expect(await f.service.listModels(providerId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: descriptor.id, toolCalling: false })]))
    const before = f.repository.models.find(providerId, descriptor.id)!
    for (const supported of [true, false, true]) {
      const changed = Promise.withResolvers<ProviderCommit>()
      const listener = f.service.onDidCommit(event => changed.resolve(event))
      data = catalogData(supported)
      await f.service.refreshModelSnapshot()
      await changed.promise
      listener.dispose()
      await f.registry.refresh()
      expect(await f.service.listModels(providerId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: descriptor.id, toolCalling: supported, enabled: true, capabilities: ['text', 'image'], sourceCapabilities: expect.objectContaining({ pdf: false, audio: false, video: false }) }),
        expect.objectContaining({ id: 'disabled', toolCalling: supported, enabled: false }),
        expect.objectContaining({ id: 'explicit-off', toolCalling: false }),
      ]))
      expect(await f.service.executionModels.resolveAvailable(selection)).toMatchObject({ id: descriptor.id, provider: providerId, toolCall: supported, contextWindow: descriptor.contextWindow, maxTokens: descriptor.maxTokens })
      expect(await f.service.getDefaultModel()).toEqual(selected)
      expect(f.repository.models.find(providerId, descriptor.id)).toMatchObject({ createdAt: before.createdAt, modelId: descriptor.id, providerId })
    }
    await f.service.setProviderEnabled(providerId, false)
    data = catalogData(false)
    await f.service.refreshModelSnapshot()
    await f.registry.refresh()
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, enabled: false }])
  })

  it('persists sparse user capabilities across metadata updates, plugin replacement and restart until explicitly restored', async () => {
    let data = catalogData(false)
    const snapshot = new ProviderModelSnapshotService({ builtin: { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data }, fetch: async () => Response.json(data) })
    const f = await fixture(snapshot)
    const automatic: ExtensionModel = { ...descriptor, tools: 'auto', catalogModels: [qwen], input: ['text'] }
    f.setModels([automatic])
    await f.registry.refresh()
    await f.service.setDefaultModel(selected)
    const overridden = providersRpc.setModelCapabilities.response.parse(await f.peers.host.request(providersRpc.setModelCapabilities.method, { providerId, modelId: descriptor.id, capabilities: { image: true, toolCall: true } }))
    expect(overridden).toMatchObject({ toolCalling: true, capabilities: ['text', 'image'], capabilityOverrides: { image: true, toolCall: true }, sourceCapabilities: { image: false, toolCall: false } })
    expect(await f.service.executionModels.resolveAvailable(selection)).toMatchObject({ toolCall: true, input: ['text', 'image'] })
    data = catalogData(true)
    await f.service.refreshModelSnapshot()
    await f.registry.refresh()
    expect(await f.service.listModels(providerId)).toMatchObject([{ capabilityOverrides: { image: true, toolCall: true }, sourceCapabilities: { toolCall: true } }])
    await f.service.setModelCapabilities(providerId, descriptor.id, { image: false, toolCall: false })
    f.setModels([{ ...automatic, input: ['text', 'image'], generation: randomUUID(), bindingRevision: 'c'.repeat(64) }])
    await f.registry.refresh()
    expect(await f.service.executionModels.resolveAvailable(selection)).toMatchObject({ toolCall: false, input: ['text'] })
    await f.service.setModelEnabled(providerId, descriptor.id, false)
    const restarted = await f.restart()
    await restarted.registry.refresh()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ enabled: false, toolCalling: false, capabilities: ['text'], capabilityOverrides: { image: false, toolCall: false }, sourceCapabilities: { image: true, toolCall: true } }])
    expect(f.repository.models.find(providerId, descriptor.id)).toMatchObject({ capabilityOverrides: { image: false, toolCall: false } })
    await restarted.service.setModelEnabled(providerId, descriptor.id, true)
    expect(await restarted.service.setModelCapabilities(providerId, descriptor.id, null)).toMatchObject({ toolCalling: true, capabilities: ['text', 'image'], capabilityOverrides: null })
    expect(await restarted.service.executionModels.resolveAvailable(selection)).toMatchObject({ toolCall: true, input: ['text', 'image'] })
    await restarted.service.setModelCapabilities(providerId, descriptor.id, { image: false })
    data = catalogData(false)
    await restarted.service.refreshModelSnapshot()
    await restarted.registry.refresh()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ toolCalling: false, capabilities: ['text'], capabilityOverrides: { image: false } }])
  })

  it('retains user capability overrides when the same plugin identity changes purpose and returns to chat', async () => {
    const f = await fixture()
    await f.registry.refresh()
    const overrides = { image: true, toolCall: true }
    await f.service.setModelCapabilities(providerId, descriptor.id, overrides)
    f.service.setCapabilityModels([{ providerId, modelId: descriptor.id, kind: 'image.generate', available: true }], 'fixture')
    expect(f.repository.models.find(providerId, descriptor.id)).toMatchObject({ api: 'plugin-image', capabilityOverrides: overrides })
    f.service.setCapabilityModels([], 'fixture')
    f.setModels([{ ...descriptor, generation: randomUUID() }])
    await f.registry.refresh()
    expect(await f.service.listModels(providerId)).toMatchObject([{ type: 'chat', toolCalling: true, capabilities: ['text', 'image'], capabilityOverrides: overrides }])
  })

  it('enforces user-disabled tools and image input at the execution and RPC boundaries', async () => {
    const f = await fixture(new ProviderModelSnapshotService())
    f.setModels([{ ...descriptor, tools: 'auto', catalogModels: [qwen] }])
    await f.registry.refresh()
    await f.service.setModelCapabilities(providerId, descriptor.id, { image: false, toolCall: false })
    const model = await f.service.executionModels.resolveAvailable(selection)
    let request: ExtensionChatRequest | undefined
    f.inference.invoke = async (_extensionId, _revision, invocation) => {
      request = extensionChatRequestSchema.parse(await readInferenceJson(invocation))
      await invocation.event({ type: 'tool', call: { id: 'call', name: 'lookup', arguments: {} } }, new Uint8Array(), invocation.signal)
    }
    const tools = [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }]
    const image = { type: 'image' as const, mimeType: 'image/png', data: pngBytes().toString('base64') }
    const rejectedImage = await f.runtime.completeSimple(model, { messages: [{ role: 'user', content: [image], timestamp: 1 }], tools })
    expect(rejectedImage).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_INPUT_UNSUPPORTED', content: [] })
    expect(request).toBeUndefined()
    const rejectedTool = await f.runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Use a tool', timestamp: 1 }], tools })
    expect(request?.tools).toEqual([])
    expect(rejectedTool).toMatchObject({ stopReason: 'error', errorMessage: 'EXTENSION_INFERENCE_TOOL_INVALID', content: [] })
  })

  it('carries effective vision and tool schemas through RPC, ordered tool events and result replay', async () => {
    const f = await fixture()
    f.setModels([{ ...descriptor, tools: false, input: ['text'] }])
    await f.registry.refresh()
    await f.peers.host.request(providersRpc.setModelCapabilities.method, { providerId, modelId: descriptor.id, capabilities: { image: true, toolCall: true } })
    const model = await f.service.executionModels.resolveAvailable(selection)
    expect(model).toMatchObject({ toolCall: true, input: ['text', 'image'] })
    const calls: Array<Extract<ExtensionChatEvent, { type: 'tool' }>['call']> = [
      { id: 'call-one', name: 'lookup', arguments: { key: 'first' } },
      { id: 'call-two', name: 'lookup', arguments: { key: 'second', optional: 'kept' } },
    ]
    const tool = { name: 'lookup', description: 'Read a fixture value', parameters: { type: 'object', properties: { key: { type: 'string' }, optional: { type: 'string' } }, required: ['key'] } }
    const image = { type: 'image' as const, mimeType: 'image/png', data: pngBytes().toString('base64') }
    const user = { role: 'user' as const, timestamp: 1, content: [{ type: 'text' as const, text: 'Inspect then look up both values' }, image] }
    const requests: ExtensionChatRequest[] = []
    f.inference.invoke = async (extensionId, revision, invocation) => {
      expect({ extensionId, revision, generation: invocation.generation, bindingRevision: invocation.bindingRevision, input: invocation.input }).toEqual({ extensionId: descriptor.extensionId, revision: descriptor.revision, generation: descriptor.generation, bindingRevision: descriptor.bindingRevision, input: { model: descriptor.id, contentType: 'application/json' } })
      requests.push(extensionChatRequestSchema.parse(await readInferenceJson(invocation)))
      const first = requests.length === 1
      if (first) {
        for (const call of calls)
          await invocation.event({ type: 'tool', call }, new Uint8Array(), invocation.signal)
      }
      else {
        await invocation.event({ type: 'text', text: 'Values received' }, new Uint8Array(), invocation.signal)
      }
      await invocation.event({ type: 'done', reason: first ? 'toolUse' : 'stop', usage: first ? { input: 7, output: 3 } : { input: 9, output: 2 } }, new Uint8Array(), invocation.signal)
    }
    const events = f.runtime.streamSimple(model, { messages: [user], tools: [tool] })
    const eventTypes = []
    for await (const event of events) eventTypes.push(event.type)
    const answer: AssistantMessage = await events.result()
    expect(eventTypes).toEqual(['start', 'toolcall_start', 'toolcall_end', 'toolcall_start', 'toolcall_end', 'done'])
    expect(answer).toMatchObject({ provider: providerId, model: descriptor.id, stopReason: 'toolUse', content: calls.map(call => ({ type: 'toolCall', ...call })) })
    expect(requests[0]).toMatchObject({ model: descriptor.id, tools: [tool], messages: expect.arrayContaining([{ role: 'user', content: user.content }]) })
    const results = calls.map((call, index) => ({ role: 'toolResult' as const, toolCallId: call.id, toolName: call.name, isError: index === 1, timestamp: 3 + index, content: [{ type: 'text' as const, text: `Result ${index + 1}` }, image] }))
    const final = await f.runtime.completeSimple(model, { messages: [user, answer, ...results], tools: [tool] })
    expect(final).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Values received' }] })
    expect(requests[1]?.messages.slice(-3)).toEqual([
      { role: 'assistant', text: '', toolCalls: calls },
      ...results.map(result => ({ role: 'tool', toolCallId: result.toolCallId, name: result.toolName, isError: result.isError, content: result.content })),
    ])
  })

  it('discovers multimodal chat models from listModels without a prior provider listing', async () => {
    const f = await fixture()
    const models = providersRpc.listModels.response.parse(await f.peers.host.request(providersRpc.listModels.method, {}))
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ providerId, modelId: descriptor.id, displayName: descriptor.title, type: 'chat', sourceType: 'chat', api: pluginChatApi, available: true, enabled: true, contextWindow: 8192, maxTokens: 512, capabilities: ['text', 'image'], sourceCapabilities: { image: true }, toolCalling: false })
    expect(models.filter(isChatModel)).toHaveLength(1)
    expect(await f.service.executionModels.resolveAvailable(selection)).toMatchObject({ input: ['text', 'image'], toolCall: false })
    await expect(f.service.setDefaultModel(selected)).resolves.toEqual(selected)
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, displayName: descriptor.extensionName, plugin: { id: descriptor.extensionId, managementPage: true }, status: 'available', enabled: true, modelCount: 1, enabledModelCount: 1, setupComplete: true, authTypes: [] }])
  })

  it('rechecks changed bindings received during a pending catalog request', async () => {
    const f = await fixture()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let models = [descriptor]
    let first = true
    f.inference.models = async () => {
      const observed = models
      if (first) {
        first = false
        started.resolve()
        await release.promise
      }
      return observed
    }
    const request = f.peers.host.request(providersRpc.listModels.method, {})
    await started.promise
    models = []
    f.peers.host.notify(extensionChatRpc.changed, {})
    release.resolve()
    expect(await request).toMatchObject([{ modelId: descriptor.id, available: false, enabled: true }])
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, status: 'unavailable' }])
  })

  it('publishes plugin lifecycle and metadata changes without a settings-page refresh', async () => {
    const f = await fixture()
    await f.registry.refresh()
    const notify = async () => {
      const committed = Promise.withResolvers<void>()
      const dispose = f.service.onDidCommit(() => committed.resolve())
      try {
        f.peers.host.notify(extensionChatRpc.changed, {})
        await committed.promise
      }
      finally { dispose.dispose() }
    }
    f.setModels([{ ...descriptor, extensionName: 'Renamed local models', managementPage: false }])
    await notify()
    expect(await f.service.listProviders()).toMatchObject([{ displayName: 'Renamed local models', status: 'available', plugin: { managementPage: false } }])
    f.setModels([])
    await notify()
    expect(await f.service.listModels(providerId)).toMatchObject([{ id: descriptor.id, type: 'chat', available: false, enabled: true, capabilities: ['text', 'image'] }])
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, status: 'unavailable', modelCount: 1 }])
    f.setModels([{ ...descriptor, generation: randomUUID() }])
    await notify()
    expect(await f.service.listModels(providerId)).toMatchObject([{ id: descriptor.id, available: true, enabled: true }])
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, displayName: descriptor.extensionName, status: 'available', plugin: { managementPage: true } }])
  })

  it('preserves identity, default selection and disabled choices through disappearance and restart', async () => {
    const f = await fixture()
    await f.registry.refresh()
    const first = f.repository.models.find(providerId, descriptor.id)!
    await f.service.setDefaultModel(selected)
    await expect(f.service.removeProvider(providerId)).rejects.toThrow()
    await expect(f.service.setModelParametersOverride(providerId, descriptor.id, { contextWindow: 32768, maxTokens: 2048 })).rejects.toThrow()
    f.setModels([])
    await f.registry.refresh()
    expect(await f.service.getDefaultModel()).toEqual(selected)
    await expect(f.service.executionModels.resolveAvailable(selection)).rejects.toThrow()
    f.setModels([descriptor])
    await f.registry.refresh()
    expect(await f.service.getDefaultModel()).toEqual(selected)
    await f.service.setProviderEnabled(providerId, false)
    f.setModels([])
    await f.registry.refresh()
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, enabled: false, status: 'unavailable' }])
    f.setModels([descriptor])
    await f.registry.refresh()
    expect(await f.service.listProviders()).toMatchObject([{ id: providerId, enabled: false, status: 'available' }])
    await f.service.setProviderEnabled(providerId, true)
    await f.service.setModelEnabled(providerId, descriptor.id, false)
    const restarted = await f.restart()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ id: descriptor.id, enabled: false, available: false }])
    await restarted.registry.refresh()
    expect(await restarted.service.listModels(providerId)).toMatchObject([{ id: descriptor.id, type: 'chat', enabled: false, available: true, capabilities: ['text', 'image'] }])
    expect(f.repository.models.find(providerId, descriptor.id)).toMatchObject({ providerId, modelId: descriptor.id, createdAt: first.createdAt })
  })

  it('keeps OCR as a tool capability without fabricating a chat model', async () => {
    const f = await fixture()
    f.setModels([])
    f.inference.imageReaders = async () => [{
      id: 'ocr',
      title: 'Local OCR',
      capability: 'ocr',
      support: { operations: ['extract'] },
      extensionId: descriptor.extensionId,
      extensionName: descriptor.extensionName,
      generation: descriptor.generation,
      revision: descriptor.revision,
      bindingRevision: descriptor.bindingRevision,
      managementPage: true,
    }]
    await f.registry.refresh()
    expect(await f.service.listModels()).toEqual([])
    expect(await f.reading.candidates()).toMatchObject([{ target: { kind: 'plugin', extensionId: descriptor.extensionId, modelId: 'ocr' }, support: { operations: ['extract'] }, available: true }])
  })
})
