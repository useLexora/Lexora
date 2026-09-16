import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import type { ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { ProviderModelInput } from '../../../shared/providers/providerInput'
import type {
  ProviderConfigRecord,
  ProviderConfigRepository,
} from '../storage/providerConfigRepository'
import type {
  ProviderModelStateRecord,
  ProviderModelStateRepository,
} from '../storage/providerModelStateRepository'
import type { InputModel } from './modelCapabilities'
import type { CatalogModel, ModelMetadataCatalog } from './ModelsDevCatalog'
import type { BuddyModel, ModelParametersOverride } from './providerSchemas'
import { createHash } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { supportsPdfInputApi } from '../../../shared/providers/pdfInput'
import { modelCapabilityOverridesSchema } from '../../../shared/providers/providerCapabilities'
import { providerModelInputSchema, storedCustomProviderModelSchema } from '../../../shared/providers/providerInput'
import { applyModelCapabilities, getModelFileInputMimeTypes, readModelCapabilities, supportsModelAudioInput, supportsModelPdfInput, supportsModelVideoInput } from './modelCapabilities'
import { serializeModelMetadata } from './modelMetadata'
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
}

export class ProviderModelCatalog {
  readonly #configs: ProviderConfigRepository
  readonly #catalogMatcher: ProviderCatalogMatcher
  readonly #modelRuntime: ProviderModelCatalogRuntime
  readonly #models: ProviderModelStateRepository

  constructor(options: ProviderModelCatalogOptions) {
    this.#configs = options.configs
    this.#catalogMatcher = new ProviderCatalogMatcher(options.metadata)
    this.#modelRuntime = options.modelRuntime
    this.#models = options.models
  }

  list(providerId?: string): readonly BuddyModel[] {
    return this.#models.list(providerId).map(model => this.#toBuddyModel(model))
  }

  summarize(): ReadonlyMap<string, ProviderModelSummary> {
    const summaries = new Map<string, ProviderModelSummary>()
    for (const model of this.#models.list()) {
      const current = summaries.get(model.providerId)
      summaries.set(model.providerId, {
        enabledModelCount: (current?.enabledModelCount ?? 0)
          + Number(model.enabled && model.available),
        modelCount: (current?.modelCount ?? 0) + 1,
      })
    }
    return summaries
  }

  hasEnabledAvailableModel(providerId: string): boolean {
    return this.#models.list(providerId)
      .some(model => model.enabled && model.available)
  }

  hasModels(providerId: string): boolean {
    return this.#models.list(providerId).length > 0
  }

  isEnabledAvailable(providerId: string, modelId: string): boolean {
    const model = this.#models.find(providerId, modelId)
    return Boolean(model?.enabled && model.available)
  }

  removeForProvider(providerId: string): void {
    this.#models.removeForProvider(providerId)
  }

  registerCustomProvider(provider: ProviderConfigRecord): void {
    this.#modelRuntime.registerProvider(provider.id, {
      api: provider.api,
      baseUrl: provider.baseUrl,
      models: this.#models.list(provider.id).map(model => this.#sourceModel(model)),
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

  reconcileBuiltinModels(providerId: string, builtinProviderId = providerId, options: { models?: readonly Model<Api>[], metadataOnly?: boolean } = {}): void {
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
        cost: channel ? model.cost : metadata?.cost ?? emptyModelCost(),
        displayName: metadata?.name ?? model.id,
        input: [...(metadata?.input ?? ['text'])],
        reasoning: channel ? model.reasoning : metadata?.reasoning ?? false,
        samplingParams: model.samplingParams ?? null,
        sourceContextWindow: channel ? model.contextWindow : metadata?.contextWindow ?? current?.sourceContextWindow ?? 128_000,
        sourceMaxTokens: channel ? model.maxTokens : metadata?.maxTokens ?? current?.sourceMaxTokens ?? 16_384,
        thinkingLevelMap: channel ? model.thinkingLevelMap ?? null : metadata?.thinkingLevelMap ?? null,
      })
      this.#models.upsert({
        catalogSelection: null,
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
      })
    }
    if (options.metadataOnly)
      return
    for (const current of this.#models.list(providerId)) {
      if (current.source === 'manual' || seen.has(current.modelId))
        continue
      this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
  }

  reconcileSyncedModels(
    provider: ProviderConfigRecord,
    definitions: ReadonlyArray<{ id: string, name?: string }>,
  ): void {
    const now = new Date().toISOString()
    const seen = new Set(definitions.map(model => model.id))
    for (const definition of definitions) {
      const current = this.#models.find(provider.id, definition.id)
      if (current?.source === 'manual')
        continue
      const source = this.#syncedSourceMetadata(provider, definition, current)
      this.#models.upsert({
        catalogSelection: current?.catalogSelection ?? null,
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
    for (const current of this.#models.list(provider.id)) {
      if (current.source !== 'synced' || seen.has(current.modelId))
        continue
      this.#models.upsert({ ...current, available: false, updatedAt: now })
    }
    this.registerCustomProvider(provider)
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

  upsertManualModel(provider: ProviderConfigRecord, input: ProviderModelInput): BuddyModel {
    const model = providerModelInputSchema.parse(input)
    const now = new Date().toISOString()
    const current = this.#models.find(provider.id, model.id)
    const source = createSourceMetadata({
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
      source: 'manual',
      sourceRevision: sourceParametersChanged(current, source)
        ? nextSourceRevision(current?.sourceRevision, now)
        : current?.sourceRevision ?? now,
      updatedAt: now,
    })
    this.registerCustomProvider(provider)
    return this.#toBuddyModel(next)
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
    this.registerCustomProvider(provider)
    return this.#toBuddyModel(next)
  }

  setCapabilitiesOverride(providerId: string, modelId: string, input: ModelCapabilityOverrides | null): BuddyModel {
    const parsed = modelCapabilityOverridesSchema.nullable().safeParse(input)
    if (!parsed.success)
      throw new ProviderValidationError()
    const current = this.#requireModelState(providerId, modelId)
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

  assertCanSetEnabled(providerId: string, modelId: string, enabled: boolean): void {
    const current = this.#models.find(providerId, modelId)
    if (!current || (enabled && !current.available))
      throw new ProviderUnavailableError()
  }

  removeUnavailableModel(providerId: string, modelId: string): void {
    const current = this.#models.find(providerId, modelId)
    if (!current || current.available)
      throw new ProviderUnavailableError()
    this.#models.remove(providerId, modelId)
    const provider = this.#configs.findById(providerId)
    if (provider)
      this.registerCustomProvider(provider)
  }

  resolve(providerId: string, modelId: string): Model<Api> {
    const model = this.#modelRuntime.getModels(providerId).find(candidate => candidate.id === modelId)
    if (!model || model.provider !== providerId)
      throw new ProviderUnavailableError()
    const state = this.#models.find(providerId, modelId)
    if (!state)
      return model
    return this.#effectiveModel(state, this.#sourceModel(state, model))
  }

  #sourceModel(model: ProviderModelStateRecord, runtimeModel = this.#modelRuntime.getModels(model.providerId).find(candidate => candidate.id === model.modelId)): InputModel {
    const provider = this.#configs.findById(model.providerId)
    const api = provider?.api ?? runtimeModel?.api ?? model.api
    const baseUrl = provider?.baseUrl ?? runtimeModel?.baseUrl ?? ''
    const metadata = model.catalogProviderId && model.catalogModelId
      ? this.#catalogMatcher.find({ providerId: model.catalogProviderId, modelId: model.catalogModelId })
      : undefined
    const sameEndpoint = Boolean(metadata?.baseUrl
      && normalizeProviderBaseUrl(metadata.baseUrl) === normalizeProviderBaseUrl(baseUrl))
    const codexPdf = model.source === 'builtin' && api === 'openai-codex-responses'
      && model.catalogProviderId === 'openai' && ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex'].includes(normalizeProviderBaseUrl(baseUrl))
    return {
      ...runtimeModel,
      api,
      baseUrl,
      pdfInput: supportsPdfInputApi(api) && metadata?.pdfInput === true && (sameEndpoint || codexPdf),
      audioInput: metadata?.audioInput === true && sameEndpoint,
      videoInput: metadata?.videoInput === true && sameEndpoint,
      toolCall: metadata?.toolCall,
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

  #effectiveModel(model: ProviderModelStateRecord, sourceModel: InputModel): InputModel {
    return applyModelCapabilities({ ...sourceModel, ...effectiveParameters(model) }, model.capabilityOverrides)
  }

  #toBuddyModel(model: ProviderModelStateRecord): BuddyModel {
    const sourceModel = this.#sourceModel(model)
    const effectiveModel = this.#effectiveModel(model, sourceModel)
    const match = model.source === 'synced'
      ? this.#catalogMatcher.match({
          api: sourceModel.api,
          baseUrl: sourceModel.baseUrl,
          modelId: model.modelId,
          selection: model.catalogSelection,
        })
      : null
    return buddyModelSchema.parse({
      api: effectiveModel.api,
      fileInputMimeTypes: getModelFileInputMimeTypes(effectiveModel),
      available: model.available,
      capabilities: [...effectiveModel.input, ...(supportsModelPdfInput(effectiveModel) ? ['pdf' as const] : []), ...(supportsModelAudioInput(effectiveModel) ? ['audio' as const] : []), ...(supportsModelVideoInput(effectiveModel) ? ['video' as const] : []), ...(effectiveModel.reasoning ? ['reasoning' as const] : [])],
      capabilityOverrides: model.capabilityOverrides,
      sourceCapabilities: readModelCapabilities(sourceModel),
      reasoningOptions: effectiveModel.reasoning ? [...getSupportedThinkingLevels(effectiveModel)] : [],
      catalogMatch: match?.status ?? 'not_applicable',
      catalog: {
        source: model.catalogProviderId && model.catalogModelId
          ? {
              providerId: model.catalogProviderId,
              modelId: model.catalogModelId,
              providerName: this.#catalogMatcher.providerName(model.catalogProviderId),
            }
          : null,
        selection: model.catalogSelection,
        candidates: match?.candidates.map(candidate => ({
          providerId: candidate.provider,
          providerName: this.#catalogMatcher.providerName(candidate.provider),
          modelId: candidate.id,
          displayName: candidate.name,
          contextWindow: candidate.contextWindow,
          maxTokens: candidate.maxTokens,
          input: [...candidate.input],
          reasoningOptions: [...getSupportedThinkingLevels({ ...candidate, api: sourceModel.api })],
          compatibility: null,
        })) ?? [],
      },
      metadataKnown: model.source !== 'synced' || model.catalogProviderId !== null,
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

  #syncedSourceMetadata(
    provider: ProviderConfigRecord,
    definition: { id: string, name?: string },
    current: ProviderModelStateRecord | null,
  ): ModelSourceMetadata {
    const match = this.#catalogMatcher.match({
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: definition.id,
      selection: current?.catalogSelection,
    })
    if (match.status === 'matched') {
      const sameEndpoint = normalizeProviderBaseUrl(provider.baseUrl) === normalizeProviderBaseUrl(match.model.baseUrl)
      return sourceMetadataFromCatalogModel(provider.api, match.model, sameEndpoint ? match.model.cost : current?.cost ?? emptyModelCost(), current)
    }

    const compatibleCurrent = current?.api === provider.api ? current : null
    return createSourceMetadata({
      api: provider.api,
      catalogProviderId: compatibleCurrent?.catalogProviderId ?? null,
      catalogModelId: compatibleCurrent?.catalogModelId ?? null,
      compat: compatibleCurrent?.compat ?? null,
      cost: current?.cost ?? emptyModelCost(),
      displayName: definition.name?.trim() || current?.displayName || definition.id,
      input: current?.input ?? ['text'],
      reasoning: compatibleCurrent?.reasoning ?? false,
      samplingParams: compatibleCurrent?.samplingParams ?? null,
      sourceContextWindow: current?.sourceContextWindow ?? 128_000,
      sourceMaxTokens: current?.sourceMaxTokens ?? 16_384,
      thinkingLevelMap: compatibleCurrent?.thinkingLevelMap ?? null,
    })
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
  api: string
  catalogProviderId: string | null
  catalogModelId: string | null
  compat: Model<Api>['compat'] | null
  cost: Model<Api>['cost']
  displayName: string
  input: Array<'text' | 'image'>
  reasoning: boolean
  samplingParams: Record<string, unknown> | null
  sourceContextWindow: number
  sourceFingerprint: string
  sourceMaxTokens: number
  thinkingLevelMap: Model<Api>['thinkingLevelMap'] | null
}

function sourceMetadataFromCatalogModel(api: string, model: CatalogModel, cost: Model<Api>['cost'], current: ProviderModelStateRecord | null = null): ModelSourceMetadata {
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
  })
}

function emptyModelCost(): Model<Api>['cost'] {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
}

function createSourceMetadata(
  input: Omit<ModelSourceMetadata, 'sourceFingerprint' | 'catalogModelId'> & { catalogModelId?: string | null },
): ModelSourceMetadata {
  const metadata = { ...input, catalogModelId: input.catalogModelId ?? null }
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
