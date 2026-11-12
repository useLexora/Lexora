import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import type { ExtensionModel } from '../../../shared/extensions/extensionChat'
import type { ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { ServiceModelMetadata } from '../../../shared/providers/providerDiscovery'
import type { ProviderModelInput } from '../../../shared/providers/providerInput'
import type { ProviderModelType } from '../../../shared/providers/providerModelType'
import type {
  ProviderConfigRecord,
  ProviderConfigRepository,
} from '../storage/providerConfigRepository'
import type {
  ProviderModelResolution,
  ProviderModelStateRecord,
  ProviderModelStateRepository,
} from '../storage/providerModelStateRepository'
import type { InputModel } from './modelCapabilities'
import type { CatalogModel, ModelMetadataCatalog } from './ModelsDevCatalog'
import type { ProviderModelDefinition, ProviderModelDiscoveryResult } from './ProviderModelDiscovery'
import type { BuddyModel, ModelParametersOverride } from './providerSchemas'
import { createHash } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { pluginChatApi } from '../../../shared/extensions/extensionChat'
import { supportsPdfInputApi } from '../../../shared/providers/pdfInput'
import { modelCapabilityOverridesSchema } from '../../../shared/providers/providerCapabilities'
import { modelDiscoveryBaseUrl, serviceModelMetadataSchema } from '../../../shared/providers/providerDiscovery'
import { providerModelInputSchema, storedCustomProviderModelSchema } from '../../../shared/providers/providerInput'
import { providerModelTypeSchema } from '../../../shared/providers/providerModelType'
import { createPluginModel } from './createPluginProvider'
import { applyModelCapabilities, getModelFileInputMimeTypes, readModelCapabilities, supportsModelAudioInput, supportsModelPdfInput, supportsModelVideoInput } from './modelCapabilities'
import { serializeModelMetadata } from './modelMetadata'
import { MODEL_RESOLUTION_VERSION, modelResolutionFingerprint } from './modelResolution'
import { normalizeProviderBaseUrl, ProviderCatalogMatcher } from './ProviderCatalogMatcher'
import { ProviderUnavailableError, ProviderValidationError } from './ProviderFailure'
import { buddyModelSchema, modelParametersOverrideSchema } from './providerSchemas'

export interface ProviderRegistration {
  api: string
  baseUrl: string
  models: Array<{
    id: string
    name: string
    reasoning: boolean
    thinkingLevelMap?: Model<Api>['thinkingLevelMap']
    input: Array<'text' | 'image'>
    cost: Model<Api>['cost']
    contextWindow: number
    maxTokens: number
    samplingParams?: Record<string, unknown>
    compat?: Model<Api>['compat']
  }>
  name: string
}

export interface ProviderModelCatalogRuntime {
  getModels: (providerId?: string) => readonly Model<Api>[]
  getProviders: () => readonly Provider[]
  registerProvider: (providerId: string, config: ProviderRegistration) => void
}

export interface ProviderModelSummary {
  readonly enabledModelCount: number
  readonly modelCount: number
}

export interface ProviderModelCatalogOptions {
  readonly configs: ProviderConfigRepository
  readonly modelRuntime: ProviderModelCatalogRuntime
  readonly models: ProviderModelStateRepository
  readonly metadata: ModelMetadataCatalog
  readonly supportsOperation?: (providerId: string, type: ProviderModelType) => boolean
}

export class ProviderModelCatalog {
  readonly #metadata: ModelMetadataCatalog
  readonly #configs: ProviderConfigRepository
  readonly #catalogMatcher: ProviderCatalogMatcher
  readonly #modelRuntime: ProviderModelCatalogRuntime
  readonly #models: ProviderModelStateRepository
  readonly #supportsOperation: NonNullable<ProviderModelCatalogOptions['supportsOperation']>

  constructor(options: ProviderModelCatalogOptions) {
    this.#metadata = options.metadata
    this.#configs = options.configs
    this.#catalogMatcher = new ProviderCatalogMatcher(options.metadata)
    this.#modelRuntime = options.modelRuntime
    this.#models = {
      ...options.models,
      upsert: record => options.models.upsert({ ...record, resolution: effectiveType(record) === 'chat' ? this.#resolveSource(record) : null }),
    }
    this.#supportsOperation = options.supportsOperation ?? (() => true)
  }

  getFingerprint(): string {
    return this.#catalogMatcher.getFingerprint()
  }

  prepareResolutions(providerId: string): void {
    for (const model of this.#models.list(providerId)) {
      if (effectiveType(model) !== 'chat')
        continue
      const resolution = this.#resolveSource(model)
      if (resolution !== model.resolution)
        this.#models.upsert({ ...model, resolution })
    }
  }

  list(providerId?: string): readonly BuddyModel[] {
    return this.#models.list(providerId).map(model => this.#toBuddyModel(model))
  }

  capture() {
    return this.#models.list().map((state) => {
      const resolution = effectiveType(state) === 'chat' ? this.#resolveSource(state) : undefined
      const source = resolution ? this.#sourceModel(state, undefined, resolution) : undefined
      const model = this.#toBuddyModel(state, source, resolution)
      if (!source)
        return { model, execution: { type: effectiveType(state), api: state.api, modelId: state.modelId } }
      const { name: _name, ...execution } = this.#effectiveModel(state, source)
      return { model, execution }
    })
  }

  summarize(): ReadonlyMap<string, ProviderModelSummary> {
    const summaries = new Map<string, ProviderModelSummary>()
    for (const model of this.#models.list()) {
      const current = summaries.get(model.providerId)
      summaries.set(model.providerId, {
        enabledModelCount: (current?.enabledModelCount ?? 0)
          + Number(model.enabled && this.#available(model)),
        modelCount: (current?.modelCount ?? 0) + 1,
      })
    }
    return summaries
  }

  hasEnabledAvailableModel(providerId: string): boolean {
    return this.#models.list(providerId)
      .some(model => model.enabled && this.#available(model))
  }

  hasModels(providerId: string): boolean {
    return this.#models.list(providerId).length > 0
  }

  isEnabledAvailable(providerId: string, modelId: string): boolean {
    const model = this.#models.find(providerId, modelId)
    return Boolean(model?.enabled && this.#available(model))
  }

  removeForProvider(providerId: string): void {
    this.#models.removeForProvider(providerId)
  }

  registerCustomProvider(provider: ProviderConfigRecord): void {
    this.#modelRuntime.registerProvider(provider.id, {
      api: provider.api,
      baseUrl: provider.baseUrl,
      models: this.#models.list(provider.id).filter(model => effectiveType(model) === 'chat').map(model => this.#sourceModel(model)),
      name: provider.displayName,
    })
  }

  seedStoredCustomModels(provider: ProviderConfigRecord): void {
    const now = new Date().toISOString()
    for (const value of provider.models) {
      const model = storedCustomProviderModelSchema.parse(value)
      const current = this.#models.find(provider.id, model.id)
      if (current)
        continue
      const source = createSourceMetadata({
        type: model.type,
        api: provider.api,
        catalogProviderId: model.catalogProviderId ?? null,
        catalogModelId: model.catalogModelId ?? null,
        compat: (model.compat as Model<Api>['compat']) ?? null,
        cost: model.cost,
        displayName: model.name,
        input: model.input,
        reasoning: model.reasoning,
        samplingParams: model.samplingParams ?? null,
        sourceContextWindow: model.contextWindow,
        sourceMaxTokens: model.maxTokens,
        thinkingLevelMap: model.thinkingLevelMap ?? null,
      })
      this.#models.upsert({
        catalogSelection: model.catalogSelection ?? null,
        capabilityOverrides: null,
        acknowledgedSourceRevision: null,
        available: true,
        createdAt: now,
        enabled: true,
        lastSeenAt: now,
        modelId: model.id,
        overrideContextWindow: null,
        overrideMaxTokens: null,
        providerId: provider.id,
        ...source,
        source: model.source ?? (model.catalogProviderId ? 'synced' : 'manual'),
        sourceRevision: now,
        updatedAt: now,
      })
    }
  }

  resolvePluginModel(model: ExtensionModel): InputModel {
    const match = this.#catalogMatcher.matchReferences(model.catalogModels ?? [])
    const defaults = match.status === 'matched' ? match.model : match.status === 'ambiguous' ? match.defaults : undefined
    return createPluginModel(model, defaults)
  }

  reconcilePluginModels(providerId: string, models: readonly Model<Api>[]): void {
    const now = new Date().toISOString()
    for (const model of models) {
      const current = this.#models.find(providerId, model.id)
      const source = createSourceMetadata({ api: model.api, catalogProviderId: null, catalogModelId: null, compat: null, cost: model.cost, displayName: model.name, input: [...model.input], reasoning: model.reasoning, samplingParams: null, sourceContextWindow: model.contextWindow, sourceMaxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap ?? null })
      this.#models.upsert({
        catalogSelection: null,
        capabilityOverrides: current?.capabilityOverrides ?? null,
        acknowledgedSourceRevision: current?.acknowledgedSourceRevision ?? null,
        available: true,
        createdAt: current?.createdAt ?? now,
        enabled: current?.enabled ?? true,
        lastSeenAt: now,
        modelId: model.id,
        providerId,
        overrideContextWindow: null,
        overrideMaxTokens: null,
        ...source,
        source: 'synced',
        sourceRevision: sourceParametersChanged(current, source) ? nextSourceRevision(current?.sourceRevision, now) : current?.sourceRevision ?? now,
        updatedAt: now,
      })
    }
    for (const current of this.#models.list(providerId)) {
      if (effectiveType(current) === 'chat' && !models.some(model => model.id === current.modelId))
        this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  reconcileBuiltinModels(providerId: string, builtinProviderId = providerId, options: { models?: readonly Model<Api>[], metadataOnly?: boolean, preserveUnchanged?: boolean } = {}): void {
    const now = new Date().toISOString()
    const runtimeModels = options.models ?? this.#modelRuntime.getModels(providerId)
    const seen = new Set(runtimeModels.map(model => model.id))
    const channel = Boolean(this.#modelRuntime.getProviders().find(provider => provider.id === providerId)?.auth.oauth)
    for (const model of runtimeModels) {
      const current = this.#models.find(providerId, model.id)
      if (current?.source === 'manual' || (options.metadataOnly && !current))
        continue
      const match = this.#catalogMatcher.match({ api: model.api, baseUrl: model.baseUrl, modelId: model.id, providerId: builtinProviderId })
      const metadata = match.status === 'matched' ? match.model : null
      const source = createSourceMetadata({
        api: model.api,
        catalogProviderId: metadata?.provider ?? null,
        catalogModelId: metadata?.id ?? null,
        compat: model.compat ?? null,
        cost: channel ? model.cost : metadata?.cost ?? model.cost,
        displayName: channel ? model.name : metadata?.name ?? model.name,
        input: [...(channel ? model.input : metadata?.input ?? model.input)],
        reasoning: channel ? model.reasoning : metadata?.reasoning ?? model.reasoning,
        samplingParams: model.samplingParams ?? null,
        sourceContextWindow: channel ? model.contextWindow : metadata?.contextWindow ?? model.contextWindow,
        sourceMaxTokens: channel ? model.maxTokens : metadata?.maxTokens ?? model.maxTokens,
        thinkingLevelMap: channel ? model.thinkingLevelMap ?? null : metadata?.thinkingLevelMap ?? model.thinkingLevelMap ?? null,
      })
      this.#upsertReconciled({
        catalogSelection: null,
        typeOverride: current?.typeOverride ?? null,
        capabilityOverrides: current?.capabilityOverrides ?? null,
        acknowledgedSourceRevision: current?.acknowledgedSourceRevision ?? null,
        available: options.metadataOnly ? current!.available : true,
        createdAt: current?.createdAt ?? now,
        enabled: current?.enabled ?? false,
        lastSeenAt: options.metadataOnly ? current!.lastSeenAt : now,
        modelId: model.id,
        overrideContextWindow: current?.overrideContextWindow ?? null,
        overrideMaxTokens: current?.overrideMaxTokens ?? null,
        providerId,
        ...source,
        source: 'builtin',
        sourceRevision: sourceParametersChanged(current, source)
          ? nextSourceRevision(current?.sourceRevision, now)
          : current?.sourceRevision ?? now,
        updatedAt: now,
      }, current, options.preserveUnchanged)
    }
    if (options.metadataOnly)
      return
    for (const current of this.#models.list(providerId)) {
      if (current.source === 'manual' || effectiveType(current) !== 'chat' || seen.has(current.modelId))
        continue
      if (current.available)
        this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  reconcileSyncedModels(
    provider: ProviderConfigRecord,
    result: ProviderModelDiscoveryResult,
  ): void {
    const definitions = result.models
    const now = new Date().toISOString()
    const seen = new Set(definitions.map(model => model.id))
    for (const definition of definitions) {
      const current = this.#models.find(provider.id, definition.id)
      if (current?.source === 'manual')
        continue
      const serviceMetadata = definition.metadata
        ? serviceModelMetadataSchema.parse({
            api: provider.api,
            baseUrl: modelDiscoveryBaseUrl(provider.baseUrl),
            metadata: definition.metadata,
          })
        : null
      const source = this.#syncedSourceMetadata(provider, definition, current, serviceMetadata)
      this.#models.upsert({
        catalogSelection: current?.catalogSelection ?? null,
        typeOverride: current?.typeOverride ?? null,
        capabilityOverrides: current?.capabilityOverrides ?? null,
        acknowledgedSourceRevision: current?.acknowledgedSourceRevision ?? null,
        available: true,
        createdAt: current?.createdAt ?? now,
        enabled: current?.enabled ?? false,
        lastSeenAt: now,
        modelId: definition.id,
        overrideContextWindow: current?.overrideContextWindow ?? null,
        overrideMaxTokens: current?.overrideMaxTokens ?? null,
        providerId: provider.id,
        ...source,
        source: 'synced',
        sourceRevision: sourceParametersChanged(current, source)
          ? nextSourceRevision(current?.sourceRevision, now)
          : current?.sourceRevision ?? now,
        updatedAt: now,
      })
    }
    if (!result.complete)
      return
    for (const current of this.#models.list(provider.id)) {
      if (current.source !== 'synced' || seen.has(current.modelId))
        continue
      this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  reconcileSyncedModelMetadata(provider: ProviderConfigRecord): boolean {
    const now = new Date().toISOString()
    let changed = false
    for (const current of this.#models.list(provider.id)) {
      if (current.source !== 'synced')
        continue
      const source = this.#syncedSourceMetadata(provider, {
        id: current.modelId,
        name: current.displayName,
      }, current)
      if (current.sourceFingerprint === source.sourceFingerprint)
        continue
      this.#models.upsert({
        ...current,
        ...source,
        sourceRevision: sourceParametersChanged(current, source)
          ? nextSourceRevision(current.sourceRevision, now)
          : current.sourceRevision,
        updatedAt: now,
      })
      changed = true
    }
    return changed
  }

  upsertManualModel(provider: Pick<ProviderConfigRecord, 'id' | 'api'>, input: ProviderModelInput): BuddyModel {
    const model = providerModelInputSchema.parse(input)
    const now = new Date().toISOString()
    const current = this.#models.find(provider.id, model.id)
    const source = createSourceMetadata({
      type: model.type,
      api: provider.api,
      catalogProviderId: null,
      compat: null,
      cost: model.cost,
      displayName: model.name,
      input: model.input,
      reasoning: model.reasoning,
      samplingParams: null,
      sourceContextWindow: model.contextWindow,
      sourceMaxTokens: model.maxTokens,
      thinkingLevelMap: null,
    })
    const next = this.#models.upsert({
      catalogSelection: null,
      capabilityOverrides: current?.capabilityOverrides ?? null,
      acknowledgedSourceRevision: current?.acknowledgedSourceRevision ?? null,
      available: true,
      createdAt: current?.createdAt ?? now,
      enabled: current?.enabled ?? true,
      lastSeenAt: now,
      modelId: model.id,
      overrideContextWindow: current?.overrideContextWindow ?? null,
      overrideMaxTokens: current?.overrideMaxTokens ?? null,
      providerId: provider.id,
      ...source,
      typeOverride: null,
      source: 'manual',
      sourceRevision: sourceParametersChanged(current, source)
        ? nextSourceRevision(current?.sourceRevision, now)
        : current?.sourceRevision ?? now,
      updatedAt: now,
    })
    return this.#toBuddyModel(next)
  }

  setType(providerId: string, modelId: string, type: ProviderModelType | null): BuddyModel {
    const current = this.#requireModelState(providerId, modelId)
    if (providerId.startsWith('plugin:'))
      throw new ProviderValidationError()
    if (!providerModelTypeSchema.nullable().safeParse(type).success)
      throw new ProviderValidationError()
    const nextType = type ?? current.type ?? 'chat'
    const next = this.#models.upsert({
      ...current,
      typeOverride: type,
      sourceContextWindow: nextType === 'chat' ? current.sourceContextWindow ?? 128_000 : current.sourceContextWindow,
      sourceMaxTokens: nextType === 'chat' ? current.sourceMaxTokens ?? 16_384 : current.sourceMaxTokens,
      updatedAt: new Date().toISOString(),
    })
    return this.#toBuddyModel(next)
  }

  reconcileCatalogModels(providerId: string, baseUrl: string, catalogProviderId: string, preserveUnchanged = false): void {
    const entries = this.#metadata.getMediaModels?.(catalogProviderId) ?? []
    const seen = new Set<string>()
    const now = new Date().toISOString()
    for (const entry of entries) {
      if (!entry.type || entry.type === 'chat' || entry.api !== 'openai-audio' || normalizeProviderBaseUrl(entry.baseUrl ?? '') !== normalizeProviderBaseUrl(baseUrl))
        continue
      seen.add(entry.id)
      const current = this.#models.find(providerId, entry.id)
      if (current?.source === 'manual')
        continue
      if (!current && !this.#supportsOperation(providerId, entry.type))
        continue
      const source = createSourceMetadata({ type: entry.type, api: 'openai-audio', catalogProviderId, catalogModelId: entry.id, compat: null, cost: emptyModelCost(), displayName: entry.name, input: ['text'], reasoning: false, samplingParams: null, sourceContextWindow: null, sourceMaxTokens: null, thinkingLevelMap: null })
      this.#upsertReconciled({
        ...source,
        providerId,
        modelId: entry.id,
        typeOverride: current?.typeOverride ?? null,
        sourceContextWindow: current?.typeOverride === 'chat' ? current.sourceContextWindow : null,
        sourceMaxTokens: current?.typeOverride === 'chat' ? current.sourceMaxTokens : null,
        catalogSelection: null,
        capabilityOverrides: current?.capabilityOverrides ?? null,
        acknowledgedSourceRevision: current?.acknowledgedSourceRevision ?? null,
        available: true,
        enabled: current?.enabled ?? false,
        source: 'builtin',
        overrideContextWindow: current?.overrideContextWindow ?? null,
        overrideMaxTokens: current?.overrideMaxTokens ?? null,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
        sourceRevision: current?.sourceRevision ?? now,
      }, current, preserveUnchanged)
    }
    for (const current of this.#models.list(providerId)) {
      if (current.source === 'builtin' && current.api === 'openai-audio' && current.available && !seen.has(current.modelId))
        this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  reconcileCapabilityModels(models: readonly import('../../../shared/providers/providerCapabilityModel').ProviderCapabilityModel[]): void {
    const now = new Date().toISOString()
    const catalogModels = models.filter(model => model.kind !== 'image.read')
    for (const model of catalogModels) {
      const current = this.#models.find(model.providerId, model.modelId)
      const source = createSourceMetadata({ type: model.kind === 'speech.transcribe' ? 'transcription' : model.kind === 'speech.synthesize' ? 'speech' : 'image-generation', api: model.kind.startsWith('image.') ? 'plugin-image' : 'plugin-speech', catalogProviderId: null, compat: null, cost: emptyModelCost(), displayName: model.title ?? model.modelId, input: ['text'], reasoning: false, samplingParams: null, sourceContextWindow: null, sourceMaxTokens: null, thinkingLevelMap: null })
      this.#models.upsert({ ...source, providerId: model.providerId, modelId: model.modelId, typeOverride: null, catalogSelection: null, capabilityOverrides: current?.capabilityOverrides ?? null, acknowledgedSourceRevision: null, available: model.available, enabled: current?.enabled ?? true, source: 'synced', overrideContextWindow: null, overrideMaxTokens: null, createdAt: current?.createdAt ?? now, updatedAt: now, lastSeenAt: now, sourceRevision: current?.sourceRevision ?? now })
    }
    for (const current of this.#models.list()) {
      if (['plugin-speech', 'plugin-image'].includes(current.api) && !catalogModels.some(model => model.providerId === current.providerId && model.modelId === current.modelId))
        this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  setCatalogSource(provider: ProviderConfigRecord, modelId: string, selection: ModelCatalogReference | null): BuddyModel {
    const current = this.#requireModelState(provider.id, modelId)
    if (current.source !== 'synced')
      throw new ProviderValidationError()
    if (selection && this.#catalogMatcher.match({
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId,
      selection,
    }).status !== 'matched') {
      throw new ProviderValidationError()
    }
    const source = this.#syncedSourceMetadata(provider, { id: modelId, name: current.displayName }, {
      ...current,
      catalogSelection: selection,
    })
    const now = new Date().toISOString()
    const next = this.#models.upsert({
      ...current,
      ...source,
      catalogSelection: selection,
      sourceRevision: sourceParametersChanged(current, source)
        ? nextSourceRevision(current.sourceRevision, now)
        : current.sourceRevision,
      updatedAt: now,
    })
    return this.#toBuddyModel(next)
  }

  setCapabilitiesOverride(providerId: string, modelId: string, input: ModelCapabilityOverrides | null): BuddyModel {
    const parsed = modelCapabilityOverridesSchema.nullable().safeParse(input)
    if (!parsed.success)
      throw new ProviderValidationError()
    const current = this.#requireModelState(providerId, modelId)
    if (effectiveType(current) !== 'chat')
      throw new ProviderValidationError()
    return this.#toBuddyModel(this.#models.upsert({
      ...current,
      capabilityOverrides: parsed.data && Object.values(parsed.data).some(value => value !== undefined) ? parsed.data : null,
      updatedAt: new Date().toISOString(),
    }))
  }

  setParametersOverride(
    providerId: string,
    modelId: string,
    input: ModelParametersOverride,
  ): BuddyModel {
    const parsed = modelParametersOverrideSchema.safeParse(input)
    if (!parsed.success)
      throw new ProviderValidationError()
    const current = this.#requireModelState(providerId, modelId)
    if (current.api === pluginChatApi || effectiveType(current) !== 'chat')
      throw new ProviderValidationError()
    const hadOverride = hasParameterOverride(current)
    const next = this.#models.upsert({
      ...current,
      acknowledgedSourceRevision: hadOverride
        ? current.acknowledgedSourceRevision
        : current.sourceRevision,
      overrideContextWindow: parsed.data.contextWindow,
      overrideMaxTokens: parsed.data.maxTokens,
      updatedAt: new Date().toISOString(),
    })
    return this.#toBuddyModel(next)
  }

  acknowledgeSourceUpdate(providerId: string, modelId: string): BuddyModel {
    const current = this.#requireModelState(providerId, modelId)
    if (!hasParameterOverride(current))
      throw new ProviderValidationError()
    return this.#toBuddyModel(this.#models.upsert({
      ...current,
      acknowledgedSourceRevision: current.sourceRevision,
      updatedAt: new Date().toISOString(),
    }))
  }

  restoreSourceParameters(providerId: string, modelId: string): BuddyModel {
    const current = this.#requireModelState(providerId, modelId)
    return this.#toBuddyModel(this.#models.upsert({
      ...current,
      acknowledgedSourceRevision: null,
      overrideContextWindow: null,
      overrideMaxTokens: null,
      updatedAt: new Date().toISOString(),
    }))
  }

  setEnabled(providerId: string, modelId: string, enabled: boolean): BuddyModel {
    this.assertCanSetEnabled(providerId, modelId, enabled)
    const current = this.#requireModelState(providerId, modelId)
    return this.#toBuddyModel(this.#models.upsert({
      ...current,
      enabled,
      updatedAt: new Date().toISOString(),
    }))
  }

  setManyEnabled(providerId: string, modelIds: readonly string[], enabled: boolean): BuddyModel[] {
    const updatedAt = new Date().toISOString()
    const records = modelIds.map((modelId) => {
      this.assertCanSetEnabled(providerId, modelId, enabled)
      return {
        ...this.#requireModelState(providerId, modelId),
        enabled,
        updatedAt,
      }
    })
    return records.map(record => this.#toBuddyModel(this.#models.upsert(record)))
  }

  assertCanSetEnabled(providerId: string, modelId: string, enabled: boolean): void {
    const current = this.#models.find(providerId, modelId)
    if (!current || (enabled && !this.#available(current)))
      throw new ProviderUnavailableError()
  }

  removeUnavailableModel(providerId: string, modelId: string): void {
    const current = this.#models.find(providerId, modelId)
    if (!current || this.#available(current))
      throw new ProviderUnavailableError()
    this.#models.remove(providerId, modelId)
  }

  executionSnapshot(providerId: string, modelId: string) {
    const state = this.#requireModelState(providerId, modelId)
    if (effectiveType(state) !== 'chat')
      return { type: effectiveType(state), api: state.api, modelId: state.modelId }
    const { name: _name, ...execution } = this.#effectiveModel(state, this.#sourceModel(state))
    return execution
  }

  resolve(providerId: string, modelId: string): Model<Api> {
    const model = this.#modelRuntime.getModels(providerId).find(candidate => candidate.id === modelId)
    if (!model || model.provider !== providerId)
      throw new ProviderUnavailableError()
    const state = this.#models.find(providerId, modelId)
    if (!state)
      return model
    if (effectiveType(state) !== 'chat')
      throw new ProviderUnavailableError()
    return this.#effectiveModel(state, this.#sourceModel(state, model))
  }

  #sourceModel(model: ProviderModelStateRecord, runtimeModel = this.#modelRuntime.getModels(model.providerId).find(candidate => candidate.id === model.modelId), resolution?: ProviderModelResolution): InputModel {
    if (model.sourceContextWindow === null || model.sourceMaxTokens === null)
      throw new ProviderValidationError()
    const provider = this.#configs.findById(model.providerId)
    const api = provider?.api ?? runtimeModel?.api ?? model.api
    const baseUrl = provider?.baseUrl ?? runtimeModel?.baseUrl ?? ''
    resolution ??= this.#resolveSource(model, api, baseUrl)
    return {
      ...runtimeModel,
      api,
      baseUrl,
      pdfInput: resolution.pdfInput,
      audioInput: resolution.audioInput,
      videoInput: resolution.videoInput,
      toolCall: model.api === pluginChatApi ? (runtimeModel as InputModel | undefined)?.toolCall === true : resolution.toolCall,
      provider: model.providerId,
      id: model.modelId,
      name: model.displayName,
      contextWindow: model.sourceContextWindow,
      maxTokens: model.sourceMaxTokens,
      cost: model.cost,
      input: model.input,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap ?? undefined,
      compat: model.compat ?? undefined,
      samplingParams: model.samplingParams ?? undefined,
    }
  }

  #resolveSource(model: ProviderModelStateRecord, api?: string, baseUrl?: string): ProviderModelResolution {
    const provider = this.#configs.findById(model.providerId)
    if (api === undefined || baseUrl === undefined) {
      const runtimeModel = this.#modelRuntime.getModels(model.providerId).find(candidate => candidate.id === model.modelId)
      api ??= provider?.api ?? runtimeModel?.api ?? model.api
      baseUrl ??= provider?.baseUrl ?? runtimeModel?.baseUrl ?? ''
    }
    const serviceMetadata = provider ? this.#serviceMetadata(provider, model) : null
    const inputFingerprint = modelResolutionFingerprint({
      version: MODEL_RESOLUTION_VERSION,
      catalog: this.#catalogMatcher.getFingerprint(),
      api,
      baseUrl,
      modelId: model.modelId,
      source: model.source,
      catalogProviderId: model.catalogProviderId,
      catalogModelId: model.catalogModelId,
      selection: model.catalogSelection,
      serviceMetadata,
    })
    if (model.resolution?.inputFingerprint === inputFingerprint)
      return model.resolution
    const match = model.source === 'synced' && model.api !== pluginChatApi
      ? this.#catalogMatcher.match({ api, baseUrl, modelId: model.modelId, selection: model.catalogSelection })
      : null
    const metadata = match
      ? match.status === 'matched' ? match.model : match.status === 'ambiguous' ? match.defaults : undefined
      : model.catalogProviderId && model.catalogModelId
        ? this.#catalogMatcher.find({ providerId: model.catalogProviderId, modelId: model.catalogModelId })
        : undefined
    const sameEndpoint = Boolean(metadata?.baseUrl
      && normalizeProviderBaseUrl(metadata.baseUrl) === normalizeProviderBaseUrl(baseUrl))
    const serviceInput = serviceMetadata?.metadata.input
    const codexPdf = model.source === 'builtin' && api === 'openai-codex-responses'
      && model.catalogProviderId === 'openai' && ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex'].includes(normalizeProviderBaseUrl(baseUrl))
    return {
      version: MODEL_RESOLUTION_VERSION,
      inputFingerprint,
      catalogMatch: match?.status ?? 'not_applicable',
      candidates: match?.candidates.map(candidate => ({ providerId: candidate.provider, modelId: candidate.id })) ?? [],
      ambiguousMetadataKnown: match?.status === 'ambiguous' && match.defaults.input !== undefined,
      pdfInput: supportsPdfInputApi(api) && (serviceInput ? serviceInput.includes('pdf') : metadata?.pdfInput === true && (sameEndpoint || codexPdf)),
      audioInput: serviceInput ? serviceInput.includes('audio') : metadata?.audioInput === true && sameEndpoint,
      videoInput: serviceInput ? serviceInput.includes('video') : metadata?.videoInput === true && sameEndpoint,
      toolCall: serviceMetadata?.metadata.toolCall ?? metadata?.toolCall,
    }
  }

  #effectiveModel(model: ProviderModelStateRecord, sourceModel: InputModel): InputModel {
    const effective = applyModelCapabilities({ ...sourceModel, ...effectiveParameters(model) }, model.capabilityOverrides)
    if (effective.api !== pluginChatApi)
      return effective
    const contextWindow = Math.min(effective.contextWindow, sourceModel.contextWindow)
    return {
      ...effective,
      contextWindow,
      maxTokens: Math.min(effective.maxTokens, sourceModel.maxTokens, contextWindow),
      reasoning: effective.reasoning && getSupportedThinkingLevels(effective).includes('medium'),
      thinkingLevelMap: { ...effective.thinkingLevelMap, off: 'none', minimal: null, low: null, high: null, xhigh: null, max: null },
    }
  }

  #available(model: ProviderModelStateRecord): boolean {
    return model.available && this.#supportsOperation(model.providerId, effectiveType(model))
  }

  #toBuddyModel(model: ProviderModelStateRecord, sourceModel?: InputModel, resolution?: ProviderModelResolution): BuddyModel {
    const type = effectiveType(model)
    if (type !== 'chat') {
      return buddyModelSchema.parse({
        type,
        sourceType: model.type ?? 'chat',
        typeOverride: model.typeOverride ?? null,
        id: model.modelId,
        providerId: model.providerId,
        displayName: model.displayName,
        api: ['plugin-speech', 'plugin-image'].includes(model.api) ? model.api : type === 'image-generation' ? 'openai-images' : 'openai-audio',
        enabled: model.enabled,
        available: this.#available(model),
        source: model.source,
        lastSeenAt: model.lastSeenAt,
        catalogMatch: model.catalogProviderId ? 'matched' : 'not_applicable',
        catalog: { source: model.catalogProviderId && model.catalogModelId ? { providerId: model.catalogProviderId, modelId: model.catalogModelId, providerName: this.#catalogMatcher.providerName(model.catalogProviderId) } : null, selection: null, candidates: [] },
        metadataKnown: true,
        capabilities: [],
        fileInputMimeTypes: [],
        capabilityOverrides: null,
        sourceCapabilities: { image: false, pdf: false, audio: false, video: false, reasoningOptions: ['off'] },
        reasoningOptions: [],
        contextWindow: null,
        maxTokens: null,
        sourceContextWindow: null,
        sourceMaxTokens: null,
        overrideContextWindow: null,
        overrideMaxTokens: null,
        hasParameterOverride: false,
        sourceParametersUpdated: false,
      })
    }
    resolution ??= this.#resolveSource(model)
    sourceModel ??= this.#sourceModel(model, undefined, resolution)
    const effectiveModel = this.#effectiveModel(model, sourceModel)
    return buddyModelSchema.parse({
      type,
      sourceType: model.type ?? 'chat',
      typeOverride: model.typeOverride ?? null,
      api: effectiveModel.api,
      toolCalling: effectiveModel.toolCall,
      fileInputMimeTypes: getModelFileInputMimeTypes(effectiveModel),
      available: this.#available(model),
      capabilities: [...effectiveModel.input, ...(supportsModelPdfInput(effectiveModel) ? ['pdf' as const] : []), ...(supportsModelAudioInput(effectiveModel) ? ['audio' as const] : []), ...(supportsModelVideoInput(effectiveModel) ? ['video' as const] : []), ...(effectiveModel.reasoning ? ['reasoning' as const] : [])],
      capabilityOverrides: model.capabilityOverrides,
      sourceCapabilities: readModelCapabilities(sourceModel),
      reasoningOptions: effectiveModel.reasoning ? [...getSupportedThinkingLevels(effectiveModel)] : [],
      catalogMatch: resolution.catalogMatch,
      catalog: {
        source: model.catalogProviderId && model.catalogModelId
          ? {
              providerId: model.catalogProviderId,
              modelId: model.catalogModelId,
              providerName: this.#catalogMatcher.providerName(model.catalogProviderId),
            }
          : null,
        selection: model.catalogSelection,
        candidates: resolution.candidates.flatMap(reference => this.#catalogMatcher.find(reference) ?? []).map(candidate => ({
          providerId: candidate.provider,
          providerName: this.#catalogMatcher.providerName(candidate.provider),
          modelId: candidate.id,
          displayName: candidate.name,
          contextWindow: candidate.contextWindow,
          maxTokens: candidate.maxTokens,
          input: [...candidate.input],
          reasoningOptions: [...getSupportedThinkingLevels({ ...candidate, api: effectiveModel.api })],
          compatibility: null,
        })),
      },
      metadataKnown: model.source !== 'synced' || model.catalogProviderId !== null || hasServiceMetadata(model)
        || resolution.ambiguousMetadataKnown,
      contextWindow: effectiveModel.contextWindow,
      displayName: model.displayName,
      enabled: model.enabled,
      id: model.modelId,
      lastSeenAt: model.lastSeenAt,
      hasParameterOverride: hasParameterOverride(model),
      maxTokens: effectiveModel.maxTokens,
      overrideContextWindow: model.overrideContextWindow,
      overrideMaxTokens: model.overrideMaxTokens,
      providerId: model.providerId,
      source: model.source,
      sourceContextWindow: model.sourceContextWindow,
      sourceMaxTokens: model.sourceMaxTokens,
      sourceParametersUpdated: hasParameterOverride(model)
        && model.acknowledgedSourceRevision !== model.sourceRevision,
    })
  }

  #serviceMetadata(provider: ProviderConfigRecord, model: ProviderModelStateRecord | null): ServiceModelMetadata | null {
    const source = model?.serviceMetadata
    return source && source.api === provider.api
      && source.baseUrl === modelDiscoveryBaseUrl(provider.baseUrl)
      ? source
      : null
  }

  #syncedSourceMetadata(
    provider: ProviderConfigRecord,
    definition: ProviderModelDefinition,
    current: ProviderModelStateRecord | null,
    serviceMetadata = this.#serviceMetadata(provider, current),
  ): ModelSourceMetadata {
    const catalogType = this.#metadata.getMediaModels?.().find(model => model.id === definition.id && model.type && model.type !== 'chat' && model.api === 'openai-audio' && normalizeProviderBaseUrl(model.baseUrl ?? '') === normalizeProviderBaseUrl(provider.baseUrl))
    const type = serviceMetadata?.metadata.type ?? catalogType?.type ?? current?.type ?? 'chat'
    if (type !== 'chat') {
      return createSourceMetadata({ type, api: provider.api, catalogProviderId: catalogType?.provider ?? null, catalogModelId: catalogType?.id ?? null, compat: null, cost: emptyModelCost(), displayName: definition.name ?? catalogType?.name ?? current?.displayName ?? definition.id, input: ['text'], reasoning: false, samplingParams: null, sourceContextWindow: current?.typeOverride === 'chat' ? current.sourceContextWindow : null, sourceMaxTokens: current?.typeOverride === 'chat' ? current.sourceMaxTokens : null, thinkingLevelMap: null }, serviceMetadata)
    }
    const match = this.#catalogMatcher.match({
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: definition.id,
      selection: current?.catalogSelection,
    })
    if (match.status === 'matched') {
      const sameEndpoint = normalizeProviderBaseUrl(provider.baseUrl) === normalizeProviderBaseUrl(match.model.baseUrl)
      return sourceMetadataFromCatalogModel(provider.api, match.model, sameEndpoint ? match.model.cost : current?.cost ?? emptyModelCost(), current, serviceMetadata)
    }

    const defaults = match.status === 'ambiguous' ? match.defaults : undefined
    const previousSource = current?.serviceMetadata || match.status === 'ambiguous' ? null : current
    const compatibleCurrent = previousSource?.api === provider.api ? previousSource : null
    const contextWindow = defaults?.contextWindow ?? previousSource?.sourceContextWindow ?? 128_000
    return createSourceMetadata({
      api: provider.api,
      catalogProviderId: compatibleCurrent?.catalogProviderId ?? null,
      catalogModelId: compatibleCurrent?.catalogModelId ?? null,
      compat: current?.api === provider.api ? current.compat : null,
      cost: current?.cost ?? emptyModelCost(),
      displayName: definition.name?.trim() || current?.displayName || definition.id,
      input: defaults?.input ?? previousSource?.input ?? ['text'],
      reasoning: defaults?.reasoning ?? compatibleCurrent?.reasoning ?? false,
      samplingParams: current?.api === provider.api ? current.samplingParams : null,
      sourceContextWindow: contextWindow,
      sourceMaxTokens: Math.min(defaults?.maxTokens ?? previousSource?.sourceMaxTokens ?? 16_384, contextWindow),
      thinkingLevelMap: defaults?.thinkingLevelMap ?? compatibleCurrent?.thinkingLevelMap ?? null,
    }, serviceMetadata)
  }

  #upsertReconciled(record: ProviderModelStateRecord, current: ProviderModelStateRecord | null, preserveUnchanged = false): ProviderModelStateRecord {
    const next = { ...record, resolution: effectiveType(record) === 'chat' ? this.#resolveSource(record) : null }
    if (preserveUnchanged && current) {
      const { updatedAt: _updated, lastSeenAt: _seen, ...previous } = current
      const { updatedAt: _nextUpdated, lastSeenAt: _nextSeen, ...value } = next
      if (serializeModelMetadata(previous) === serializeModelMetadata(value))
        return current
    }
    return this.#models.upsert(next)
  }

  #requireModelState(providerId: string, modelId: string): ProviderModelStateRecord {
    const model = this.#models.find(providerId, modelId)
    if (!model)
      throw new ProviderUnavailableError()
    return model
  }
}

function hasParameterOverride(model: ProviderModelStateRecord): boolean {
  return model.overrideContextWindow !== null && model.overrideMaxTokens !== null
}

function effectiveParameters(model: ProviderModelStateRecord): ModelParametersOverride {
  if (model.sourceContextWindow === null || model.sourceMaxTokens === null)
    throw new ProviderValidationError()
  if (hasParameterOverride(model)) {
    return {
      contextWindow: model.overrideContextWindow!,
      maxTokens: model.overrideMaxTokens!,
    }
  }
  return {
    contextWindow: model.sourceContextWindow,
    maxTokens: model.sourceMaxTokens,
  }
}

function nextSourceRevision(previous: string | undefined, candidate: string): string {
  if (!previous || candidate > previous)
    return candidate
  return new Date(Date.parse(previous) + 1).toISOString()
}

interface ModelSourceMetadata {
  type: ProviderModelType
  serviceMetadata: ServiceModelMetadata | null
  api: string
  catalogProviderId: string | null
  catalogModelId: string | null
  compat: Model<Api>['compat'] | null
  cost: Model<Api>['cost']
  displayName: string
  input: Array<'text' | 'image'>
  reasoning: boolean
  samplingParams: Record<string, unknown> | null
  sourceContextWindow: number | null
  sourceFingerprint: string
  sourceMaxTokens: number | null
  thinkingLevelMap: Model<Api>['thinkingLevelMap'] | null
}

function sourceMetadataFromCatalogModel(api: string, model: CatalogModel, cost: Model<Api>['cost'], current: ProviderModelStateRecord | null = null, serviceMetadata: ServiceModelMetadata | null = null): ModelSourceMetadata {
  return createSourceMetadata({
    api,
    catalogProviderId: model.provider,
    catalogModelId: model.id,
    compat: current?.api === api ? current.compat : null,
    cost,
    displayName: model.name,
    input: [...model.input],
    reasoning: model.reasoning,
    samplingParams: current?.api === api ? current.samplingParams : null,
    sourceContextWindow: model.contextWindow,
    sourceMaxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
  }, serviceMetadata)
}

function emptyModelCost(): Model<Api>['cost'] {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
}

function createSourceMetadata(
  input: Omit<ModelSourceMetadata, 'type' | 'sourceFingerprint' | 'catalogModelId' | 'serviceMetadata'> & { type?: ProviderModelType, catalogModelId?: string | null },
  serviceMetadata: ServiceModelMetadata | null = null,
): ModelSourceMetadata {
  const declared = serviceMetadata?.metadata
  const reasoningOptions = declared?.reasoningOptions
  const contextWindow = declared?.contextWindow ?? input.sourceContextWindow
  const maxTokens = declared?.maxTokens ?? input.sourceMaxTokens
  const metadata = {
    ...input,
    type: input.type ?? 'chat' as const,
    catalogModelId: input.catalogModelId ?? null,
    serviceMetadata,
    ...(declared && (input.type ?? 'chat') === 'chat'
      ? {
          displayName: declared.name ?? input.displayName,
          input: declared.input ? declared.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image') : input.input,
          reasoning: reasoningOptions !== undefined ? reasoningOptions.some(level => level !== 'off') : input.reasoning,
          thinkingLevelMap: reasoningOptions !== undefined
            ? Object.fromEntries(BUDDY_THINKING_LEVELS.map(level => [level, reasoningOptions.includes(level) ? level === 'off' ? 'none' : level : null]))
            : input.thinkingLevelMap,
          sourceContextWindow: declared.contextWindow === undefined ? Math.max(contextWindow ?? 128_000, maxTokens ?? 16_384) : contextWindow,
          sourceMaxTokens: declared.maxTokens === undefined ? Math.min(maxTokens ?? 16_384, contextWindow ?? 128_000) : maxTokens,
        }
      : {}),
  }
  return {
    ...metadata,
    sourceFingerprint: createHash('sha256')
      .update(serializeModelMetadata(metadata))
      .digest('hex'),
  }
}

function sourceParametersChanged(
  current: ProviderModelStateRecord | null,
  next: ModelSourceMetadata,
): boolean {
  return !current
    || current.sourceContextWindow !== next.sourceContextWindow
    || current.sourceMaxTokens !== next.sourceMaxTokens
}

function hasServiceMetadata(model: ProviderModelStateRecord): boolean {
  return Boolean(model.serviceMetadata && Object.entries(model.serviceMetadata.metadata).some(([key, value]) => key !== 'name' && value !== undefined))
}

function effectiveType(model: ProviderModelStateRecord): ProviderModelType {
  return model.typeOverride ?? model.type ?? 'chat'
}
