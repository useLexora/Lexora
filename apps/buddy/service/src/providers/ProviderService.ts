import type {
  AuthType,
  Provider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { ProviderRequestHeader } from '../../../shared/providers/providerHeaders'
import type { BuddyDefaultModel, CustomProviderInput, ProviderModelInput } from '../../../shared/providers/providerInput'
import type { BuiltinProviderConfigRecord, BuiltinProviderConfigRepository } from '../storage/builtinProviderConfigRepository'
import type { DefaultModelRepository } from '../storage/defaultModelRepository'
import type {
  ProviderConfigRecord,
  ProviderConfigRepository,
} from '../storage/providerConfigRepository'
import type { ProviderRepository } from '../storage/providerRepository'
import type { ProviderStateRepository } from '../storage/providerStateRepository'
import type { AuthInteractionService } from './AuthInteractionService'
import type { ProviderCredentialStatus } from './ProviderCredentialStatus'
import type {
  ProviderModelCatalogRuntime,
} from './ProviderModelCatalog'
import type { ProviderModelDiscovery } from './ProviderModelDiscovery'
import type { ProviderModelSnapshotStatus } from './ProviderModelSnapshotService'
import type { BuddyModel, BuddyProvider, ModelParametersOverride } from './providerSchemas'
import { randomUUID } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { providerRequestHeadersSchema } from '../../../shared/providers/providerHeaders'
import { customProviderInputSchema, defaultModelSchema, providerDisplayNameSchema } from '../../../shared/providers/providerInput'
import { createBuiltinProviderInstance } from './createBuiltinProviderInstance'
import { ProviderExecutionModelResolver } from './ProviderExecutionModelResolver'
import {
  ProviderAuthenticationRequiredError,
  ProviderIdConflictError,
  ProviderInUseError,
  ProviderModelSyncError,
  ProviderModelSyncUnsupportedError,
  ProviderUnavailableError,
  ProviderValidationError,
} from './ProviderFailure'
import { ProviderModelCatalog } from './ProviderModelCatalog'
import { ProviderModelSnapshotService } from './ProviderModelSnapshotService'
import { ProviderRequestHeaders } from './ProviderRequestHeaders'
import { buddyProviderSchema } from './providerSchemas'

export interface ProviderModelRuntime extends ProviderModelCatalogRuntime {
  getProvider: (providerId: string) => Provider | undefined
  getProviders: () => readonly Provider[]
  login: ModelRuntime['login']
  logout: ModelRuntime['logout']
  refresh: ModelRuntime['refresh']
  registerNativeProvider: ModelRuntime['registerNativeProvider']
  unregisterProvider: (providerId: string) => void
  getAvailable: ModelRuntime['getAvailable']
}

type ModelSnapshot = Pick<ProviderModelSnapshotService, 'initialize' | 'getModels' | 'getProviders' | 'getStatus' | 'refresh'>

export interface ProviderServiceOptions {
  requestHeaders?: ProviderRequestHeaders
  createBuiltinSource?: (providerId: string) => Provider | undefined
  authInteractions: AuthInteractionService
  credentialStatus: ProviderCredentialStatus
  getActiveRuns?: () => ReadonlyArray<{ model: string, provider: string }>
  modelDiscovery: ProviderModelDiscovery
  modelRuntime: ProviderModelRuntime
  snapshotPath?: string
  modelSnapshot?: ModelSnapshot
  providers: ProviderRepository
  sessionRuntime?: ModelRuntime
}

export class ProviderService {
  readonly #requestHeaders: ProviderRequestHeaders
  readonly #builtins: BuiltinProviderConfigRepository
  readonly #builtinTemplates: ReadonlyMap<string, Provider>
  readonly #createBuiltinSource: (providerId: string) => Provider | undefined
  readonly #authInteractions: AuthInteractionService
  readonly #configs: ProviderConfigRepository
  readonly #credentialStatus: ProviderCredentialStatus
  readonly #defaultModel: DefaultModelRepository
  readonly #getActiveRuns: () => ReadonlyArray<{ model: string, provider: string }>
  readonly #modelDiscovery: ProviderModelDiscovery
  readonly #modelRuntime: ProviderModelRuntime
  readonly #modelCatalog: ProviderModelCatalog
  readonly #modelSnapshot: ModelSnapshot
  readonly #states: ProviderStateRepository
  readonly executionModels: ProviderExecutionModelResolver

  constructor(options: ProviderServiceOptions) {
    this.#requestHeaders = options.requestHeaders ?? new ProviderRequestHeaders(options.providers.states)
    this.#builtins = options.providers.builtins
    this.#builtinTemplates = new Map(options.modelRuntime.getProviders().map(provider => [provider.id, provider]))
    this.#createBuiltinSource = options.createBuiltinSource ?? (id => builtinProviders().find(provider => provider.id === id))
    this.#authInteractions = options.authInteractions
    this.#configs = options.providers.configs
    this.#credentialStatus = options.credentialStatus
    this.#defaultModel = options.providers.defaultModel
    this.#getActiveRuns = options.getActiveRuns ?? (() => [])
    this.#modelDiscovery = options.modelDiscovery
    this.#modelRuntime = options.modelRuntime
    this.#modelSnapshot = options.modelSnapshot ?? new ProviderModelSnapshotService({ snapshotPath: options.snapshotPath })
    this.#modelCatalog = new ProviderModelCatalog({
      configs: options.providers.configs,
      metadata: this.#modelSnapshot,
      modelRuntime: options.modelRuntime,
      models: options.providers.models,
    })
    this.#states = options.providers.states
    this.executionModels = new ProviderExecutionModelResolver({
      builtins: options.providers.builtins,
      credentialStatus: options.credentialStatus,
      modelCatalog: this.#modelCatalog,
      sessionRuntime: options.sessionRuntime,
      states: options.providers.states,
    })
  }

  async initializeProviders(): Promise<void> {
    await this.#modelSnapshot.initialize()
    const customProviderIds = new Set<string>()
    for (const provider of this.#configs.list()) {
      customProviderIds.add(provider.id)
      this.#ensureProviderState(provider.id, provider.enabled)
      this.#modelCatalog.seedStoredCustomModels(provider)
      this.#modelCatalog.reconcileSyncedModelMetadata(provider)
      this.#modelCatalog.registerCustomProvider(provider)
    }
    const credentialProviderIds = new Set((await this.#credentialStatus.listOrEmpty())
      .map(credential => credential.providerId))
    for (const provider of this.#builtinTemplates.values()) {
      if (customProviderIds.has(provider.id)
        || (!this.#states.findByProviderId(provider.id) && !credentialProviderIds.has(provider.id))) {
        continue
      }
      this.#ensureProviderState(provider.id, false)
      if (!this.#builtins.findById(provider.id)) {
        const now = new Date().toISOString()
        this.#builtins.upsert({
          id: provider.id,
          builtinProviderId: provider.id,
          displayName: null,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
    const instances = this.#builtins.list()
    for (const instance of instances) {
      this.#ensureProviderState(instance.id, false)
      this.#registerBuiltinInstance(instance)
    }
    if (instances.length)
      await this.#modelRuntime.refresh({ allowNetwork: false, providers: instances.map(instance => instance.id) })
    for (const instance of instances) {
      if (this.#modelRuntime.getProvider(instance.id))
        await this.#reconcileBuiltinModels(instance, credentialProviderIds.has(instance.id))
    }
  }

  listBuiltinPresets() {
    return [...this.#builtinTemplates.values()].map(provider => ({
      id: provider.id,
      displayName: provider.name,
      baseUrl: provider.baseUrl ?? null,
      authTypes: providerAuthTypes(provider),
    })).sort((left, right) => left.displayName.localeCompare(right.displayName))
  }

  async listProviders(): Promise<readonly BuddyProvider[]> {
    const credentialList = await this.#credentialStatus.listOrEmpty()
    const credentials = new Map(credentialList
      .map(credential => [credential.providerId, credential.type]))
    const customProviders = new Map(this.#configs.list().map(provider => [provider.id, provider]))
    const providerStates = new Map(this.#states.list().map(state => [state.providerId, state]))
    const modelSummaries = this.#modelCatalog.summarize()
    const builtinInstances = new Map(this.#builtins.list().map(instance => [instance.id, instance]))
    const instanceIds = new Set([...builtinInstances.keys(), ...customProviders.keys()])
    const providers = [...instanceIds].map((id) => {
      const provider = this.#modelRuntime.getProvider(id)
      const builtin = builtinInstances.get(id)
      const custom = customProviders.get(id)
      const template = builtin ? this.#builtinTemplates.get(builtin.builtinProviderId) : undefined
      const state = providerStates.get(id)
      const storedCredentialType = credentials.get(id) ?? null
      const modelSummary = modelSummaries.get(id)
      const enabled = state?.enabled ?? custom?.enabled ?? Boolean(storedCredentialType)
      const enabledModelCount = modelSummary?.enabledModelCount ?? 0
      const syncUnavailableReason = this.#syncUnavailableReason(custom, storedCredentialType, provider)
      return buddyProviderSchema.parse({
        requestHeaders: this.#requestHeaders.list(id),
        id,
        builtinProviderId: builtin?.builtinProviderId ?? null,
        api: custom?.api ?? null,
        description: custom?.description ?? null,
        displayName: custom?.displayName ?? builtin?.displayName ?? template?.name ?? id,
        baseUrl: custom?.baseUrl ?? provider?.baseUrl ?? null,
        canSyncModels: Boolean(provider && syncUnavailableReason === null),
        authTypes: provider ? providerAuthTypes(provider) : custom ? ['api_key'] : [],
        storedCredentialType,
        status: !provider ? 'unavailable' : storedCredentialType ? 'available' : 'authentication_required',
        custom: Boolean(custom),
        activeRunCount: this.#activeRunsForProvider(id).length,
        added: true,
        enabled,
        enabledModelCount,
        modelCount: modelSummary?.modelCount ?? 0,
        setupComplete: Boolean(provider && storedCredentialType !== null && enabledModelCount > 0),
        syncUnavailableReason: !provider && custom ? 'unsupported_api' : syncUnavailableReason,
      })
    })
    return providers.sort((left, right) => left.displayName.localeCompare(right.displayName))
  }

  async listModels(providerId?: string): Promise<readonly BuddyModel[]> {
    return this.#modelCatalog.list(providerId)
  }

  getModelSnapshot(): Promise<ProviderModelSnapshotStatus> {
    return this.#modelSnapshot.getStatus()
  }

  async refreshModelSnapshot(): Promise<ProviderModelSnapshotStatus> {
    await this.#modelSnapshot.refresh()
    for (const instance of this.#builtins.list()) {
      if (this.#modelRuntime.getProvider(instance.id))
        this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, { metadataOnly: true })
    }
    for (const provider of this.#configs.list()) {
      if (this.#modelCatalog.reconcileSyncedModelMetadata(provider))
        this.#modelCatalog.registerCustomProvider(provider)
    }
    return this.#modelSnapshot.getStatus()
  }

  async addProvider(providerId: string): Promise<BuddyProvider> {
    const template = this.#builtinTemplates.get(providerId)
    if (!template)
      throw new ProviderUnavailableError()
    const existingNames = new Set((await this.listProviders()).map(provider => provider.displayName))
    let displayName = template.name
    for (let index = 2; existingNames.has(displayName); index += 1)
      displayName = `${template.name} ${index}`
    const now = new Date().toISOString()
    const instance: BuiltinProviderConfigRecord = {
      id: `builtin-${randomUUID()}`,
      builtinProviderId: providerId,
      displayName,
      createdAt: now,
      updatedAt: now,
    }
    if (!this.#registerBuiltinInstance(instance))
      throw new ProviderUnavailableError()
    this.#builtins.upsert(instance)
    this.#ensureProviderState(instance.id, false)
    await this.#modelRuntime.refresh({ allowNetwork: false, providers: [instance.id] })
    await this.#reconcileBuiltinModels(instance, false)
    return this.#requireListedProvider(instance.id)
  }

  async renameProvider(providerId: string, displayName: string, requestHeaders?: readonly ProviderRequestHeader[]): Promise<BuddyProvider> {
    if (requestHeaders !== undefined) {
      this.#assertProviderIdle(providerId)
      if (!providerRequestHeadersSchema.safeParse(requestHeaders).success)
        throw new ProviderValidationError()
    }
    const parsed = providerDisplayNameSchema.safeParse(displayName)
    if (!parsed.success)
      throw new ProviderValidationError()
    const builtin = this.#builtins.findById(providerId)
    const custom = this.#configs.findById(providerId)
    const updatedAt = new Date().toISOString()
    if (builtin)
      this.#builtins.upsert({ ...builtin, displayName: parsed.data, updatedAt })
    else if (custom)
      this.#configs.upsert({ ...custom, displayName: parsed.data, updatedAt })
    else
      throw new ProviderUnavailableError()
    if (requestHeaders !== undefined)
      this.#requestHeaders.save(providerId, requestHeaders)
    return this.#requireListedProvider(providerId)
  }

  async upsertManualModel(providerId: string, input: ProviderModelInput): Promise<BuddyModel> {
    const custom = this.#configs.findById(providerId)
    if (!custom)
      throw new ProviderValidationError()
    this.#assertProviderIdle(providerId)
    return this.#modelCatalog.upsertManualModel(custom, input)
  }

  async setModelCatalogSource(providerId: string, modelId: string, source: ModelCatalogReference | null): Promise<BuddyModel> {
    const provider = this.#configs.findById(providerId)
    if (!provider)
      throw new ProviderValidationError()
    this.#assertProviderIdle(providerId)
    return this.#modelCatalog.setCatalogSource(provider, modelId, source)
  }

  async setModelCapabilities(providerId: string, modelId: string, capabilities: ModelCapabilityOverrides | null): Promise<BuddyModel> {
    this.#assertProviderIdle(providerId)
    return this.#modelCatalog.setCapabilitiesOverride(providerId, modelId, capabilities)
  }

  async setModelParametersOverride(
    providerId: string,
    modelId: string,
    input: ModelParametersOverride,
  ): Promise<BuddyModel> {
    return this.#modelCatalog.setParametersOverride(providerId, modelId, input)
  }

  async acknowledgeModelSourceUpdate(providerId: string, modelId: string): Promise<BuddyModel> {
    return this.#modelCatalog.acknowledgeSourceUpdate(providerId, modelId)
  }

  async restoreModelSourceParameters(providerId: string, modelId: string): Promise<BuddyModel> {
    return this.#modelCatalog.restoreSourceParameters(providerId, modelId)
  }

  async setModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<BuddyModel> {
    this.#modelCatalog.assertCanSetEnabled(providerId, modelId, enabled)
    if (!enabled)
      this.#assertModelIdle(providerId, modelId)
    const next = this.#modelCatalog.setEnabled(providerId, modelId, enabled)
    if (!enabled)
      this.#clearDefaultIfMatches(providerId, modelId)
    return next
  }

  async removeModel(providerId: string, modelId: string): Promise<void> {
    this.#assertModelIdle(providerId, modelId)
    this.#modelCatalog.removeUnavailableModel(providerId, modelId)
    this.#clearDefaultIfMatches(providerId, modelId)
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<BuddyProvider> {
    const current = this.#states.findByProviderId(providerId)
    if (!current)
      throw new ProviderUnavailableError()
    if (!enabled)
      this.#assertProviderIdle(providerId)
    if (enabled) {
      const credentials = await this.#credentialStatus.list()
      if (!credentials.some(credential => credential.providerId === providerId))
        throw new ProviderAuthenticationRequiredError()
      if (!this.#modelCatalog.hasEnabledAvailableModel(providerId))
        throw new ProviderUnavailableError()
    }
    this.#states.upsert({
      ...current,
      enabled,
      updatedAt: new Date().toISOString(),
    })
    if (!enabled)
      this.#clearDefaultForProvider(providerId)
    return this.#requireListedProvider(providerId)
  }

  getDefaultModel(): Promise<BuddyDefaultModel | null> {
    const current = this.#defaultModel.find()
    return Promise.resolve(current
      ? defaultModelSchema.parse({
          modelId: current.modelId,
          providerId: current.providerId,
          reasoning: current.reasoning,
        })
      : null)
  }

  async setDefaultModel(value: BuddyDefaultModel | null): Promise<BuddyDefaultModel | null> {
    if (!value) {
      this.#defaultModel.clear()
      return null
    }
    const parsed = defaultModelSchema.parse(value)
    const resolvedModel = await this.executionModels.resolveAvailable({
      contextWindow: null,
      maxTokens: null,
      modelId: parsed.modelId,
      providerId: parsed.providerId,
    })
    if (
      parsed.reasoning !== null
      && !getSupportedThinkingLevels(resolvedModel).includes(parsed.reasoning)
    ) {
      throw new ProviderValidationError()
    }
    const stored = this.#defaultModel.set({ ...parsed, updatedAt: new Date().toISOString() })
    return defaultModelSchema.parse({
      modelId: stored.modelId,
      providerId: stored.providerId,
      reasoning: stored.reasoning,
    })
  }

  async syncModels(providerId: string): Promise<readonly BuddyModel[]> {
    if (!this.#states.findByProviderId(providerId))
      throw new ProviderUnavailableError()
    const custom = this.#configs.findById(providerId)
    const instance = this.#builtins.findById(providerId)
    if (instance) {
      this.#assertProviderIdle(providerId)
      const provider = this.#modelRuntime.getProvider(providerId)
      if (!provider)
        throw new ProviderModelSyncUnsupportedError()
      if (!(await this.#credentialStatus.list()).some(credential => credential.providerId === providerId))
        throw new ProviderAuthenticationRequiredError()
      const result = await this.#modelRuntime.refresh({ allowNetwork: true, force: true, providers: [providerId] })
      if (result.aborted || result.errors.size)
        throw new ProviderModelSyncError()
      await this.#reconcileBuiltinModels(instance, true)
      return this.listModels(providerId)
    }
    if (!custom || !this.#modelDiscovery.supports(custom.api))
      throw new ProviderModelSyncUnsupportedError()
    this.#assertProviderIdle(providerId)
    const definitions = await this.#modelDiscovery.discover({
      api: custom.api,
      baseUrl: custom.baseUrl,
      providerId,
    })
    this.#modelCatalog.reconcileSyncedModels(custom, definitions)
    return this.listModels(providerId)
  }

  async login(providerId: string, type: AuthType): Promise<void> {
    this.#assertProviderIdle(providerId)
    const provider = this.#modelRuntime.getProvider(providerId)
    if (!provider || !provider.auth[type === 'api_key' ? 'apiKey' : 'oauth'])
      throw new ProviderUnavailableError()

    const handle = this.#authInteractions.beginLogin(providerId)
    try {
      await this.#modelRuntime.login(providerId, type, handle.interaction)
      const instance = this.#builtins.findById(providerId)
      if (instance) {
        if (provider.refreshModels)
          await this.#modelRuntime.refresh({ allowNetwork: true, providers: [providerId] })
        await this.#reconcileBuiltinModels(instance, true)
      }
    }
    finally {
      this.#authInteractions.completeLogin(handle.loginId)
    }
  }

  respondToPrompt(challengeId: string, value: string): Promise<void> {
    this.#authInteractions.respondToPrompt(challengeId, value)
    return Promise.resolve()
  }

  cancelLogin(challengeId: string): Promise<void> {
    this.#authInteractions.cancelLogin(challengeId)
    return Promise.resolve()
  }

  async logout(providerId: string): Promise<void> {
    this.#assertProviderIdle(providerId)
    await this.#modelRuntime.logout(providerId)
  }

  async clearCredential(providerId: string): Promise<void> {
    this.#assertProviderIdle(providerId)
    await this.#modelRuntime.logout(providerId)
  }

  async removeProvider(providerId: string): Promise<void> {
    this.#assertProviderIdle(providerId)
    await this.#modelRuntime.logout(providerId)
    this.#clearDefaultForProvider(providerId)
    this.#modelCatalog.removeForProvider(providerId)
    this.#states.remove(providerId)
    const builtin = this.#builtins.findById(providerId)
    if (builtin) {
      this.#builtins.remove(providerId)
      if (builtin.id !== builtin.builtinProviderId)
        this.#modelRuntime.unregisterProvider(providerId)
    }
    if (this.#configs.findById(providerId)) {
      this.#configs.remove(providerId)
      this.#modelRuntime.unregisterProvider(providerId)
    }
  }

  async upsertCustomProvider(input: CustomProviderInput): Promise<BuddyProvider> {
    return this.#saveCustomProvider(input, false)
  }

  async createCustomProvider(input: CustomProviderInput): Promise<BuddyProvider> {
    return this.#saveCustomProvider(input, true)
  }

  async #saveCustomProvider(input: CustomProviderInput, createOnly: boolean): Promise<BuddyProvider> {
    const parsed = customProviderInputSchema.safeParse(input)
    if (!parsed.success)
      throw new ProviderValidationError()

    const existing = this.#configs.findById(parsed.data.id)
    if ((createOnly && existing) || (!existing && (this.#modelRuntime.getProvider(parsed.data.id) || this.#builtins.findById(parsed.data.id))))
      throw new ProviderIdConflictError()
    if (existing)
      this.#assertProviderIdle(parsed.data.id)
    const now = new Date().toISOString()
    const models = parsed.data.models.length > 0 ? parsed.data.models : existing?.models ?? []
    const record = this.#configs.upsert({
      id: parsed.data.id,
      displayName: parsed.data.displayName,
      description: parsed.data.description || null,
      api: parsed.data.api,
      baseUrl: parsed.data.baseUrl,
      models,
      credentialRef: parsed.data.id,
      enabled: parsed.data.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    this.#ensureProviderState(record.id, parsed.data.enabled)
    if (parsed.data.requestHeaders !== undefined)
      this.#requestHeaders.save(record.id, parsed.data.requestHeaders)
    this.#modelCatalog.seedStoredCustomModels(record)
    this.#modelCatalog.reconcileSyncedModelMetadata(record)
    this.#modelCatalog.registerCustomProvider(record)
    const provider = (await this.listProviders()).find(provider => provider.id === record.id)
    if (!provider)
      throw new ProviderUnavailableError()
    return provider
  }

  #ensureProviderState(providerId: string, enabled: boolean): void {
    const current = this.#states.findByProviderId(providerId)
    const now = new Date().toISOString()
    this.#states.upsert({
      createdAt: current?.createdAt ?? now,
      enabled: current?.enabled ?? enabled,
      providerId,
      updatedAt: now,
    })
  }

  #registerBuiltinInstance(instance: BuiltinProviderConfigRecord): boolean {
    const template = this.#builtinTemplates.get(instance.builtinProviderId)
    if (!template)
      return false
    if (instance.id !== instance.builtinProviderId) {
      const source = this.#createBuiltinSource(instance.builtinProviderId)
      if (!source)
        return false
      this.#modelRuntime.registerNativeProvider(createBuiltinProviderInstance({
        id: instance.id,
        name: instance.displayName ?? template.name,
        source,
        getCatalogModels: () => this.#modelRuntime.getModels(instance.builtinProviderId),
      }))
    }
    return true
  }

  async #reconcileBuiltinModels(instance: BuiltinProviderConfigRecord, authenticated: boolean): Promise<void> {
    const models = authenticated
      ? await this.#modelRuntime.getAvailable(instance.id)
      : this.#modelRuntime.getModels(instance.id)
    this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, {
      models,
      metadataOnly: !authenticated && this.#modelCatalog.hasModels(instance.id),
    })
  }

  #syncUnavailableReason(
    custom: ProviderConfigRecord | undefined,
    storedCredentialType: 'api_key' | 'oauth' | null,
    provider: Provider | undefined,
  ): 'authentication_required' | 'unsupported_api' | null {
    if (!custom)
      return provider ? storedCredentialType ? null : 'authentication_required' : 'unsupported_api'
    if (!this.#modelDiscovery.supports(custom.api))
      return 'unsupported_api'
    return storedCredentialType ? null : 'authentication_required'
  }

  async #requireListedProvider(providerId: string): Promise<BuddyProvider> {
    const provider = (await this.listProviders()).find(candidate => candidate.id === providerId)
    if (!provider)
      throw new ProviderUnavailableError()
    return provider
  }

  #activeRunsForProvider(providerId: string) {
    return this.#getActiveRuns().filter(run => run.provider === providerId)
  }

  #assertProviderIdle(providerId: string): void {
    if (this.#activeRunsForProvider(providerId).length > 0)
      throw new ProviderInUseError()
  }

  #assertModelIdle(providerId: string, modelId: string): void {
    if (this.#getActiveRuns().some(run => run.provider === providerId && run.model === modelId))
      throw new ProviderInUseError()
  }

  #clearDefaultForProvider(providerId: string): void {
    if (this.#defaultModel.find()?.providerId === providerId)
      this.#defaultModel.clear()
  }

  #clearDefaultIfMatches(providerId: string, modelId: string): void {
    const current = this.#defaultModel.find()
    if (current?.providerId === providerId && current.modelId === modelId)
      this.#defaultModel.clear()
  }
}

function providerAuthTypes(provider: Provider): Array<'api_key' | 'oauth'> {
  return [
    ...(provider.auth.apiKey ? ['api_key' as const] : []),
    ...(provider.auth.oauth ? ['oauth' as const] : []),
  ]
}

export type { ProviderFailureCode } from './ProviderFailure'
export {
  ProviderAuthenticationRequiredError,
  ProviderFailure,
  ProviderInUseError,
  ProviderModelSyncError,
  ProviderModelSyncUnsupportedError,
  ProviderUnavailableError,
  ProviderValidationError,
} from './ProviderFailure'
