import type {
  AuthType,
  LoginOptions,
  Provider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Event } from '../../../shared/events/Emitter'
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
import type { CredentialChange, HostCredentialStore } from './HostCredentialStore'
import type { ProviderCredentialStatus } from './ProviderCredentialStatus'
import type {
  ProviderModelCatalogRuntime,
} from './ProviderModelCatalog'
import type { ProviderModelDiscovery } from './ProviderModelDiscovery'
import type { ModelMetadataChange, ProviderModelSnapshotStatus } from './ProviderModelSnapshotService'
import type { BuddyModel, BuddyProvider, ModelParametersOverride } from './providerSchemas'
import type { ProviderCommit } from './ProviderState'
import { randomUUID } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { Emitter } from '../../../shared/events/Emitter'
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
import { ProviderState } from './ProviderState'

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

type ModelSnapshot = Pick<ProviderModelSnapshotService, 'initialize' | 'getModels' | 'getProviders' | 'getStatus' | 'refresh'> & Partial<Pick<ProviderModelSnapshotService, 'onDidChange' | 'dispose'>>

export interface ProviderServiceOptions {
  loginOptions?: LoginOptions
  requestHeaders?: ProviderRequestHeaders
  createBuiltinSource?: (providerId: string) => Provider | undefined
  authInteractions: AuthInteractionService
  credentialStatus: ProviderCredentialStatus
  credentials?: Pick<HostCredentialStore, 'onDidChange' | 'snapshot' | 'dispose'>
  getActiveRuns?: () => ReadonlyArray<{ model: string, provider: string }>
  modelDiscovery: ProviderModelDiscovery
  modelRuntime: ProviderModelRuntime
  snapshotPath?: string
  modelSnapshot?: ModelSnapshot
  providers: ProviderRepository
  sessionRuntime?: ModelRuntime
}

export class ProviderService {
  readonly #loginOptions: LoginOptions | undefined
  readonly #requestHeaders: ProviderRequestHeaders
  readonly #builtins: BuiltinProviderConfigRepository
  readonly #builtinTemplates: ReadonlyMap<string, Provider>
  readonly #createBuiltinSource: (providerId: string) => Provider | undefined
  readonly #authInteractions: AuthInteractionService
  readonly #configs: ProviderConfigRepository
  readonly #credentials: ProviderServiceOptions['credentials']
  readonly #credentialStatus: ProviderCredentialStatus
  readonly #defaultModel: DefaultModelRepository
  readonly #getActiveRuns: () => ReadonlyArray<{ model: string, provider: string }>
  readonly #modelDiscovery: ProviderModelDiscovery
  readonly #modelRuntime: ProviderModelRuntime
  readonly #modelCatalog: ProviderModelCatalog
  readonly #modelSnapshot: ModelSnapshot
  readonly #states: ProviderStateRepository
  readonly executionModels: ProviderExecutionModelResolver
  readonly #state: ProviderState
  readonly #operations = new Emitter<{ readonly operationId: string, readonly operation: string, readonly stage: 'started' | 'completed' | 'failed' | 'cancelled' }>(() => console.error('PROVIDER_OPERATION_OBSERVER_FAILED'))
  readonly onDidOperate = this.#operations.event
  readonly #pending = new Set<Promise<unknown>>()
  readonly #shutdown = new AbortController()
  #stopping = false
  #quiescence: Promise<void> | undefined
  #disposal: Promise<void> | undefined
  readonly #applications = new Emitter<{ readonly providerId: string, readonly revision: number, readonly operationId: string, readonly stage: 'started' | 'applied' | 'failed' }>(() => console.error('PROVIDER_APPLICATION_OBSERVER_FAILED'))
  readonly onDidApplyCatalog = this.#applications.event
  readonly onDidChangeCredential: Event<CredentialChange> = (listener, options) => this.#credentials?.onDidChange(listener, options) ?? { dispose() {} }
  readonly onDidChangeMetadata: Event<ModelMetadataChange> = (listener, options) => this.#modelSnapshot.onDidChange?.(listener, options) ?? { dispose() {} }
  readonly onDidCommit: Event<ProviderCommit> = (listener, options) => this.#state.onDidCommit(listener, options)

  get snapshot() { return this.#state.snapshot }

  constructor(options: ProviderServiceOptions) {
    this.#loginOptions = options.loginOptions
    this.#requestHeaders = options.requestHeaders ?? new ProviderRequestHeaders(options.providers.states)
    this.#builtins = options.providers.builtins
    this.#builtinTemplates = new Map(options.modelRuntime.getProviders().map(provider => [provider.id, provider]))
    this.#createBuiltinSource = options.createBuiltinSource ?? ((id) => {
      const source = builtinProviders().find(provider => provider.id === id)
      return source?.refreshModels ? source : this.#builtinTemplates.get(id)
    })
    this.#authInteractions = options.authInteractions
    this.#configs = options.providers.configs
    this.#credentialStatus = options.credentialStatus
    this.#credentials = options.credentials
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
      metadata: this.#modelSnapshot,
      modelCatalog: this.#modelCatalog,
      sessionRuntime: options.sessionRuntime,
      states: options.providers.states,
    })
    this.#state = new ProviderState(() => this.#capture())
  }

  async initializeProviders(): Promise<void> {
    return this.#operate('initializeProviders', async () => {
      await this.#modelSnapshot.initialize()
      const customProviderIds = new Set<string>()
      for (const provider of this.#configs.list()) {
        customProviderIds.add(provider.id)
        this.#state.commit('initialize', () => {
          this.#ensureProviderState(provider.id, provider.enabled)
          this.#modelCatalog.seedStoredCustomModels(provider)
          this.#modelCatalog.reconcileSyncedModelMetadata(provider)
        })
        this.#applyCatalog(provider.id, () => this.#modelCatalog.registerCustomProvider(provider))
      }
      const credentialProviderIds = new Set((await this.#credentialStatus.listOrEmpty())
        .map(credential => credential.providerId))
      for (const provider of this.#builtinTemplates.values()) {
        const ids = provider.id === 'azure' ? [provider.id, 'azure-openai-responses'] : [provider.id]
        for (const id of ids) {
          if (customProviderIds.has(id)
            || (!this.#states.findByProviderId(id) && !credentialProviderIds.has(id))) {
            continue
          }
          this.#state.commit('initialize', () => {
            this.#ensureProviderState(id, false)
            if (!this.#builtins.findById(id)) {
              const now = new Date().toISOString()
              this.#builtins.upsert({
                id,
                builtinProviderId: provider.id,
                displayName: null,
                createdAt: now,
                updatedAt: now,
              })
            }
          })
        }
      }
      const instances = this.#builtins.list()
      for (const instance of instances) {
        this.#state.commit('initialize', () => this.#ensureProviderState(instance.id, false))
        this.#registerBuiltinInstance(instance)
      }
      if (instances.length)
        await this.#modelRuntime.refresh({ signal: this.#shutdown.signal, allowNetwork: false, providers: instances.map(instance => instance.id) })
      for (const instance of instances) {
        if (this.#modelRuntime.getProvider(instance.id))
          await this.#reconcileBuiltinModels(instance, credentialProviderIds.has(instance.id))
      }
    })
  }

  listBuiltinPresets() {
    return [...this.#builtinTemplates.values()].filter(provider => provider.getModels().length > 0 || !provider.getAllModels?.().length).map(provider => ({
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
        status: !provider || this.#credentialStatus.availability === 'unknown' ? 'unavailable' : storedCredentialType ? 'available' : 'authentication_required',
        custom: Boolean(custom),
        activeRunCount: this.#activeRunsForProvider(id).length,
        added: true,
        enabled,
        enabledModelCount,
        modelCount: modelSummary?.modelCount ?? 0,
        setupComplete: Boolean(provider && storedCredentialType !== null),
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
    return this.#operate('refreshModelSnapshot', async () => {
      await this.#modelSnapshot.refresh()
      for (const instance of this.#builtins.list()) {
        if (this.#modelRuntime.getProvider(instance.id))
          this.#state.commit('metadata', () => this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, { metadataOnly: true }))
      }
      for (const provider of this.#configs.list()) {
        if (this.#state.commit('metadata', () => this.#modelCatalog.reconcileSyncedModelMetadata(provider)))
          this.#applyCatalog(provider.id, () => this.#modelCatalog.registerCustomProvider(provider))
      }
      return this.#modelSnapshot.getStatus()
    })
  }

  async addProvider(providerId: string): Promise<BuddyProvider> {
    return this.#operate('addProvider', async () => {
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
      const runtimeProvider = this.#createBuiltinInstance(instance)
      if (!runtimeProvider)
        throw new ProviderUnavailableError()
      this.#state.commit('configuration', () => {
        this.#builtins.upsert(instance)
        this.#ensureProviderState(instance.id, false)
      })
      this.#applyCatalog(instance.id, () => this.#modelRuntime.registerNativeProvider(runtimeProvider))
      await this.#modelRuntime.refresh({ signal: this.#shutdown.signal, allowNetwork: false, providers: [instance.id] })
      await this.#reconcileBuiltinModels(instance, false)
      return this.#requireListedProvider(instance.id)
    })
  }

  async renameProvider(providerId: string, displayName: string, requestHeaders?: readonly ProviderRequestHeader[]): Promise<BuddyProvider> {
    return this.#operate('renameProvider', async () => {
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
      this.#state.commit('configuration', () => {
        if (builtin)
          this.#builtins.upsert({ ...builtin, displayName: parsed.data, updatedAt })
        else if (custom)
          this.#configs.upsert({ ...custom, displayName: parsed.data, updatedAt })
        else
          throw new ProviderUnavailableError()
        if (requestHeaders !== undefined)
          this.#requestHeaders.save(providerId, requestHeaders)
      })
      return this.#requireListedProvider(providerId)
    })
  }

  async upsertManualModel(providerId: string, input: ProviderModelInput): Promise<BuddyModel> {
    return this.#operate('upsertManualModel', async () => {
      const custom = this.#configs.findById(providerId)
      if (!custom)
        throw new ProviderValidationError()
      this.#assertProviderIdle(providerId)
      const model = this.#state.commit('configuration', () => this.#modelCatalog.upsertManualModel(custom, input))
      this.#applyCatalog(providerId, () => this.#modelCatalog.registerCustomProvider(custom))
      return model
    })
  }

  async setModelCatalogSource(providerId: string, modelId: string, source: ModelCatalogReference | null): Promise<BuddyModel> {
    return this.#operate('setModelCatalogSource', async () => {
      const provider = this.#configs.findById(providerId)
      if (!provider)
        throw new ProviderValidationError()
      this.#assertProviderIdle(providerId)
      const model = this.#state.commit('configuration', () => this.#modelCatalog.setCatalogSource(provider, modelId, source))
      this.#applyCatalog(providerId, () => this.#modelCatalog.registerCustomProvider(provider))
      return model
    })
  }

  async setModelCapabilities(providerId: string, modelId: string, capabilities: ModelCapabilityOverrides | null): Promise<BuddyModel> {
    return this.#operate('setModelCapabilities', async () => {
      this.#assertProviderIdle(providerId)
      return this.#state.commit('configuration', () => this.#modelCatalog.setCapabilitiesOverride(providerId, modelId, capabilities))
    })
  }

  async setModelParametersOverride(
    providerId: string,
    modelId: string,
    input: ModelParametersOverride,
  ): Promise<BuddyModel> {
    return this.#operate('setModelParametersOverride', async () => {
      return this.#state.commit('configuration', () => this.#modelCatalog.setParametersOverride(providerId, modelId, input))
    })
  }

  async acknowledgeModelSourceUpdate(providerId: string, modelId: string): Promise<BuddyModel> {
    return this.#operate('acknowledgeModelSourceUpdate', async () => {
      return this.#state.commit('configuration', () => this.#modelCatalog.acknowledgeSourceUpdate(providerId, modelId))
    })
  }

  async restoreModelSourceParameters(providerId: string, modelId: string): Promise<BuddyModel> {
    return this.#operate('restoreModelSourceParameters', async () => {
      return this.#state.commit('configuration', () => this.#modelCatalog.restoreSourceParameters(providerId, modelId))
    })
  }

  async setModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<BuddyModel> {
    return this.#operate('setModelEnabled', async () => {
      this.#modelCatalog.assertCanSetEnabled(providerId, modelId, enabled)
      if (!enabled)
        this.#assertModelIdle(providerId, modelId)
      return this.#state.commit('configuration', () => {
        const next = this.#modelCatalog.setEnabled(providerId, modelId, enabled)
        if (!enabled)
          this.#clearDefaultIfMatches(providerId, modelId)
        return next
      })
    })
  }

  async removeModel(providerId: string, modelId: string): Promise<void> {
    return this.#operate('removeModel', async () => {
      this.#assertModelIdle(providerId, modelId)
      this.#state.commit('configuration', () => {
        this.#modelCatalog.removeUnavailableModel(providerId, modelId)
        this.#clearDefaultIfMatches(providerId, modelId)
      })
      const provider = this.#configs.findById(providerId)
      if (provider)
        this.#applyCatalog(providerId, () => this.#modelCatalog.registerCustomProvider(provider))
    })
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<BuddyProvider> {
    return this.#operate('setProviderEnabled', async () => {
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
      this.#assertProviderCurrent(providerId, current)
      this.#state.commit('configuration', () => {
        this.#states.upsert({ ...current, enabled, updatedAt: new Date().toISOString() })
        if (!enabled)
          this.#clearDefaultForProvider(providerId)
      })
      return this.#requireListedProvider(providerId)
    })
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
    return this.#operate('setDefaultModel', async () => {
      if (!value) {
        this.#state.commit('configuration', () => this.#defaultModel.clear())
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
      const stored = this.#state.commit('configuration', () => this.#defaultModel.set({ ...parsed, updatedAt: new Date().toISOString() }))
      return defaultModelSchema.parse({
        modelId: stored.modelId,
        providerId: stored.providerId,
        reasoning: stored.reasoning,
      })
    })
  }

  async syncModels(providerId: string): Promise<readonly BuddyModel[]> {
    return this.#operate('syncModels', async () => {
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
        const result = await this.#modelRuntime.refresh({ signal: this.#shutdown.signal, allowNetwork: true, force: true, providers: [providerId] })
        if (result.aborted || result.errors.size)
          throw new ProviderModelSyncError()
        if (JSON.stringify(this.#builtins.findById(providerId)) !== JSON.stringify(instance))
          throw new ProviderUnavailableError()
        this.#assertProviderIdle(providerId)
        await this.#reconcileBuiltinModels(instance, true)
        return this.listModels(providerId)
      }
      if (!custom || !this.#modelDiscovery.supports(custom.api))
        throw new ProviderModelSyncUnsupportedError()
      this.#assertProviderIdle(providerId)
      const definitions = await this.#modelDiscovery.discover({
        signal: this.#shutdown.signal,
        api: custom.api,
        baseUrl: custom.baseUrl,
        providerId,
      })
      if (JSON.stringify(this.#configs.findById(providerId)) !== JSON.stringify(custom))
        throw new ProviderUnavailableError()
      this.#assertProviderIdle(providerId)
      this.#state.commit('discovery', () => this.#modelCatalog.reconcileSyncedModels(custom, definitions))
      this.#applyCatalog(providerId, () => this.#modelCatalog.registerCustomProvider(custom))
      return this.listModels(providerId)
    })
  }

  async login(providerId: string, type: AuthType): Promise<void> {
    return this.#operate('login', async () => {
      this.#assertProviderIdle(providerId)
      const provider = this.#modelRuntime.getProvider(providerId)
      if (!provider || !provider.auth[type === 'api_key' ? 'apiKey' : 'oauth'])
        throw new ProviderUnavailableError()

      const handle = this.#authInteractions.beginLogin(providerId)
      let outcome: 'completed' | 'failed' | 'cancelled' = 'failed'
      try {
        await this.#modelRuntime.login(providerId, type, handle.interaction, this.#loginOptions)
        const instance = this.#builtins.findById(providerId)
        if (instance) {
          if (provider.refreshModels)
            await this.#modelRuntime.refresh({ signal: this.#shutdown.signal, allowNetwork: true, providers: [providerId] })
          await this.#reconcileBuiltinModels(instance, true)
        }
        outcome = 'completed'
      }
      finally {
        if (handle.interaction.signal?.aborted)
          outcome = 'cancelled'
        this.#authInteractions.completeLogin(handle.loginId, outcome)
      }
    })
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
    return this.#operate('logout', async () => {
      this.#assertProviderIdle(providerId)
      await this.#modelRuntime.logout(providerId)
    })
  }

  async clearCredential(providerId: string): Promise<void> {
    return this.#operate('clearCredential', async () => {
      this.#assertProviderIdle(providerId)
      await this.#modelRuntime.logout(providerId)
    })
  }

  async removeProvider(providerId: string): Promise<void> {
    return this.#operate('removeProvider', async () => {
      this.#assertProviderIdle(providerId)
      await this.#modelRuntime.logout(providerId)
      this.#assertProviderIdle(providerId)
      this.#state.commit('configuration', () => {
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
      })
    })
  }

  async upsertCustomProvider(input: CustomProviderInput): Promise<BuddyProvider> {
    return this.#operate('upsertCustomProvider', async () => {
      return this.#saveCustomProvider(input, false)
    })
  }

  async createCustomProvider(input: CustomProviderInput): Promise<BuddyProvider> {
    return this.#operate('createCustomProvider', async () => {
      return this.#saveCustomProvider(input, true)
    })
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
    const record = this.#state.commit('configuration', () => {
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
      return record
    })
    this.#applyCatalog(record.id, () => this.#modelCatalog.registerCustomProvider(record))
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
    const provider = this.#createBuiltinInstance(instance)
    if (!provider)
      return false
    this.#applyCatalog(instance.id, () => this.#modelRuntime.registerNativeProvider(provider))
    return true
  }

  #createBuiltinInstance(instance: BuiltinProviderConfigRecord): Provider | null {
    const template = this.#builtinTemplates.get(instance.builtinProviderId)
    const source = template && this.#createBuiltinSource(instance.builtinProviderId)
    if (!source || !template)
      return null
    return createBuiltinProviderInstance({
      id: instance.id,
      name: instance.displayName ?? template.name,
      source,
      getCatalogModels: () => template.getAllModels?.() ?? template.getModels(),
    })
  }

  async #reconcileBuiltinModels(instance: BuiltinProviderConfigRecord, authenticated: boolean): Promise<void> {
    const models = authenticated
      ? await this.#modelRuntime.getAvailable(instance.id)
      : this.#modelRuntime.getModels(instance.id)
    if (!this.#builtins.findById(instance.id))
      throw new ProviderUnavailableError()
    this.#state.commit('discovery', () => this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, {
      models,
      metadataOnly: !authenticated && this.#modelCatalog.hasModels(instance.id),
    }))
  }

  #capture() {
    const builtin = new Map(this.#builtins.list().map(provider => [provider.id, provider]))
    const custom = new Map(this.#configs.list().map(provider => [provider.id, provider]))
    return {
      providers: [...new Set([...builtin.keys(), ...custom.keys()])].sort().map(id => ({
        id,
        enabled: this.#states.findByProviderId(id)?.enabled ?? false,
        presentation: { name: custom.get(id)?.displayName ?? builtin.get(id)?.displayName, description: custom.get(id)?.description },
        execution: { api: custom.get(id)?.api, baseUrl: custom.get(id)?.baseUrl, builtin: builtin.get(id)?.builtinProviderId, headers: this.#requestHeaders.list(id) },
      })),
      models: this.#modelCatalog.list().map(model => ({ model, execution: { ...this.#modelCatalog.executionSnapshot(model.providerId, model.id), serviceTiers: this.executionModels.getServiceTiers({ providerId: model.providerId, modelId: model.id, api: model.api }) } })),
      defaultModel: (() => {
        const value = this.#defaultModel.find()
        return value ? { providerId: value.providerId, modelId: value.modelId, reasoning: value.reasoning } : null
      })(),
    }
  }

  #assertProviderCurrent(providerId: string, current: import('../storage/providerStateRepository').ProviderStateRecord): void {
    if (JSON.stringify(this.#states.findByProviderId(providerId)) !== JSON.stringify(current))
      throw new ProviderUnavailableError()
  }

  #applyCatalog(providerId: string, apply: () => void): void {
    const identity = { providerId, revision: this.#state.snapshot.revision, operationId: randomUUID() }
    this.#applications.fire(Object.freeze({ ...identity, stage: 'started' }))
    try {
      this.#shutdown.signal.throwIfAborted()
      apply()
      this.#applications.fire(Object.freeze({ ...identity, stage: 'applied' }))
    }
    catch (error) {
      this.#applications.fire(Object.freeze({ ...identity, stage: 'failed' }))
      throw error
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  quiesce(): Promise<void> {
    if (this.#quiescence)
      return this.#quiescence
    this.#stopping = true
    this.#shutdown.abort()
    this.#authInteractions.dispose()
    this.#quiescence = (async () => {
      const failures: unknown[] = []
      try {
        await this.#modelSnapshot.dispose?.()
      }
      catch (error) { failures.push(error) }
      await this.whenIdle()
      try {
        await this.#credentials?.dispose()
      }
      catch (error) { failures.push(error) }
      if (failures.length)
        throw new AggregateError(failures, 'Provider shutdown failed')
    })()
    return this.#quiescence
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.quiesce().finally(() => {
      this.#operations.dispose()
      this.#applications.dispose()
      this.#state.dispose()
    })
    return this.#disposal
  }

  #operate<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new ProviderUnavailableError())
    const operationId = randomUUID()
    const result = Promise.resolve().then(() => {
      this.#shutdown.signal.throwIfAborted()
      return work()
    }).then((value) => {
      this.#operations.fire(Object.freeze({ operationId, operation, stage: 'completed' }))
      return value
    }, (error: unknown) => {
      this.#operations.fire(Object.freeze({ operationId, operation, stage: this.#stopping ? 'cancelled' : 'failed' }))
      throw error
    })
    this.#pending.add(result)
    void result.then(() => this.#pending.delete(result), () => this.#pending.delete(result))
    this.#operations.fire(Object.freeze({ operationId, operation, stage: 'started' }))
    return result
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
