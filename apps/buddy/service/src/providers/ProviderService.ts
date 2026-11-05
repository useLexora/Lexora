import type {
  Api,
  AuthType,
  LoginOptions,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Event } from '../../../shared/events/Emitter'
import type { ExtensionModel } from '../../../shared/extensions/extensionChat'
import type { ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import type { ProviderCapabilityModel } from '../../../shared/providers/providerCapabilityModel'
import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { ProviderRequestHeader } from '../../../shared/providers/providerHeaders'
import type { BuddyDefaultModel, CustomProviderInput, ProviderModelInput } from '../../../shared/providers/providerInput'
import type { ProviderModelType } from '../../../shared/providers/providerModelType'
import type { BuiltinProviderConfigRecord, BuiltinProviderConfigRepository } from '../storage/builtinProviderConfigRepository'
import type { DefaultModelRepository } from '../storage/defaultModelRepository'
import type {
  ProviderConfigRecord,
  ProviderConfigRepository,
} from '../storage/providerConfigRepository'
import type { ProviderRepository } from '../storage/providerRepository'
import type { ProviderResolutionRepository } from '../storage/providerResolutionRepository'
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
import { pluginProviderPrefix } from '../../../shared/extensions/extensionChat'
import { providerRequestHeadersSchema } from '../../../shared/providers/providerHeaders'
import { customProviderInputSchema, defaultModelSchema, providerDisplayNameSchema } from '../../../shared/providers/providerInput'
import { createBuiltinProviderInstance } from './createBuiltinProviderInstance'
import { MODEL_RESOLUTION_VERSION, modelResolutionFingerprint } from './modelResolution'
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

type ModelSnapshot = Pick<ProviderModelSnapshotService, 'initialize' | 'getModels' | 'getProviders' | 'getStatus' | 'refresh'> & Partial<Pick<ProviderModelSnapshotService, 'onDidChange' | 'dispose' | 'getMediaModels' | 'getFingerprint'>>

export interface ProviderServiceOptions {
  resolutionRepository?: ProviderResolutionRepository
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
  readonly #resolutionRepository: ProviderResolutionRepository | undefined
  readonly #resolutions = new Emitter<{ readonly providerId: string, readonly restored: boolean }>(() => console.error('PROVIDER_RESOLUTION_OBSERVER_FAILED'))
  readonly onDidResolve = this.#resolutions.event
  #operationGeneration = 0
  readonly #loginOptions: LoginOptions | undefined
  readonly #requestHeaders: ProviderRequestHeaders
  readonly #builtins: BuiltinProviderConfigRepository
  readonly #plugins = new Map<string, readonly ExtensionModel[]>()
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
  readonly #transaction: ProviderRepository['transaction']
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

  getCredentialMetadata(providerId: string): { readonly type: AuthType, readonly revision: number } | null {
    const snapshot = this.#credentials?.snapshot
    if (snapshot?.availability !== 'known')
      return null
    const credential = snapshot.providers.find(credential => credential.providerId === providerId)
    if (credential?.presence !== 'present' || !credential.type)
      return null
    return { type: credential.type, revision: credential.revision }
  }

  constructor(options: ProviderServiceOptions) {
    this.#resolutionRepository = options.resolutionRepository
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
      supportsOperation: (providerId, type) => {
        const source = this.#builtins.findById(providerId)?.builtinProviderId
        return type === 'chat' || !((source === 'openai' || source === 'openai-codex') && this.#credentialStatus.type(providerId) === 'oauth')
      },
    })
    this.#states = options.providers.states
    this.#transaction = options.providers.transaction
    this.executionModels = new ProviderExecutionModelResolver({
      isPluginAvailable: id => this.#plugins.has(id) && Boolean(this.#modelRuntime.getProvider(id)),
      builtins: options.providers.builtins,
      credentialStatus: options.credentialStatus,
      metadata: this.#modelSnapshot,
      modelCatalog: this.#modelCatalog,
      sessionRuntime: options.sessionRuntime,
      states: options.providers.states,
    })
    this.#state = new ProviderState(() => this.#capture(), { deferInitialRead: true })
  }

  async initializeProviders(): Promise<void> {
    return this.#operate('initializeProviders', async (generation) => {
      this.#state.commit('initialize', () => {
        for (const id of this.pluginProviderIds())
          this.#modelCatalog.reconcilePluginModels(id, [])
        this.#modelCatalog.reconcileCapabilityModels([])
      })
      await this.#modelSnapshot.initialize()
      const credentialProviderIds = new Set((await this.#credentialStatus.listOrEmpty()).map(credential => credential.providerId))
      this.#assertOperationCurrent(generation)
      const customProviders = this.#configs.list()
      const customProviderIds = new Set(customProviders.map(provider => provider.id))
      const instances = new Map(this.#builtins.list().map(instance => [instance.id, instance]))
      for (const provider of this.#builtinTemplates.values()) {
        const ids = provider.id === 'azure' ? [provider.id, 'azure-openai-responses'] : [provider.id]
        for (const id of ids) {
          if (instances.has(id) || customProviderIds.has(id)
            || (!this.#states.findByProviderId(id) && !credentialProviderIds.has(id))) {
            continue
          }
          const now = new Date().toISOString()
          instances.set(id, { id, builtinProviderId: provider.id, displayName: null, createdAt: now, updatedAt: now })
        }
      }
      for (const instance of instances.values())
        this.#registerBuiltinInstance(instance)
      if (instances.size)
        await this.#modelRuntime.refresh({ signal: this.#shutdown.signal, allowNetwork: false, providers: [...instances.keys()] })
      const prepared = new Map<string, readonly Model<Api>[]>()
      for (const instance of instances.values()) {
        if (this.#modelRuntime.getProvider(instance.id)) {
          prepared.set(instance.id, credentialProviderIds.has(instance.id)
            ? await this.#modelRuntime.getAvailable(instance.id)
            : this.#modelRuntime.getModels(instance.id))
        }
      }
      this.#assertOperationCurrent(generation)
      this.#state.commit('initialize', () => {
        for (const provider of customProviders) {
          this.#ensureProviderState(provider.id, provider.enabled)
          this.#restoreResolution(provider.id, { kind: 'custom', api: provider.api, baseUrl: provider.baseUrl, models: provider.models }, () => {
            this.#modelCatalog.seedStoredCustomModels(provider)
            this.#modelCatalog.reconcileSyncedModelMetadata(provider)
          })
          this.#applyCatalog(provider.id, () => this.#modelCatalog.registerCustomProvider(provider))
        }
        for (const instance of instances.values()) {
          this.#ensureProviderState(instance.id, false)
          if (!this.#builtins.findById(instance.id))
            this.#builtins.upsert(instance)
          const models = prepared.get(instance.id)
          if (!models)
            continue
          const authenticated = credentialProviderIds.has(instance.id)
          this.#restoreResolution(instance.id, this.#builtinResolutionInput(instance, authenticated, models), () => this.#commitBuiltinModels(instance, authenticated, models, true))
        }
      })
    })
  }

  resolvePluginModelTools(model: Pick<ExtensionModel, 'tools' | 'catalogModels'>): boolean {
    return this.#modelCatalog.resolvePluginModelTools(model)
  }

  resolvePluginModelReasoning(model: Pick<ExtensionModel, 'reasoning' | 'catalogModels'>): boolean {
    return this.#modelCatalog.resolvePluginModelReasoning(model)
  }

  pluginProviderIds(): string[] {
    return [...new Set([...this.#plugins.keys(), ...this.#states.list().map(state => state.providerId).filter(id => id.startsWith(pluginProviderPrefix))])]
  }

  async applyPluginProvider(id: string, provider: Provider | undefined, descriptors: readonly ExtensionModel[] | undefined): Promise<void> {
    if (!id.startsWith(pluginProviderPrefix) || this.#configs.findById(id) || this.#builtins.findById(id))
      throw new ProviderIdConflictError()
    return this.#operate('applyPluginProvider', async () => {
      this.#state.commit('discovery', () => {
        if (provider && descriptors?.length) {
          this.#plugins.set(id, descriptors)
          this.#ensureProviderState(id, true)
          this.#applyCatalog(id, () => this.#modelRuntime.registerNativeProvider(provider))
        }
        else {
          this.#plugins.delete(id)
          this.#applyCatalog(id, () => this.#modelRuntime.unregisterProvider(id))
        }
        this.#modelCatalog.reconcilePluginModels(id, provider?.getModels() ?? [])
      })
      await this.#modelRuntime.refresh({ allowNetwork: false, providers: [id], signal: this.#shutdown.signal })
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

  #capabilityModels: readonly ProviderCapabilityModel[] = []
  #capabilitySources = new Map<string, readonly ProviderCapabilityModel[]>()
  setCapabilityModels(models: readonly ProviderCapabilityModel[], source = 'speech'): void {
    this.#capabilitySources.set(source, models)
    const combined = [...this.#capabilitySources.values()].flat()
    if (JSON.stringify(combined) === JSON.stringify(this.#capabilityModels))
      return
    this.#state.commit('discovery', () => {
      this.#capabilityModels = combined
      this.#modelCatalog.reconcileCapabilityModels(combined)
      for (const model of combined) {
        if (model.providerId?.startsWith('plugin:'))
          this.#ensureProviderState(model.providerId, true)
      }
    })
  }

  async listProviders(): Promise<readonly BuddyProvider[]> {
    const credentialList = await this.#credentialStatus.listOrEmpty()
    const credentials = new Map(credentialList
      .map(credential => [credential.providerId, credential.type]))
    const customProviders = new Map(this.#configs.list().map(provider => [provider.id, provider]))
    const providerStates = new Map(this.#states.list().map(state => [state.providerId, state]))
    const modelSummaries = this.#modelCatalog.summarize()
    const builtinInstances = new Map(this.#builtins.list().map(instance => [instance.id, instance]))
    const instanceIds = new Set([...builtinInstances.keys(), ...customProviders.keys(), ...this.pluginProviderIds(), ...this.#capabilityModels.flatMap(item => item.providerId?.startsWith('plugin:') ? [item.providerId] : [])])
    const providers = [...instanceIds].map((id) => {
      const provider = this.#modelRuntime.getProvider(id)
      const capabilities = this.#capabilityModels.filter(item => item.providerId === id)
      const capabilityPlugin = capabilities.find(item => item.plugin)?.plugin
      const chatPlugin = this.#plugins.get(id)?.[0]
      const plugin = id.startsWith(pluginProviderPrefix)
        ? chatPlugin
          ? { id: chatPlugin.extensionId, name: chatPlugin.providerName ?? chatPlugin.extensionName, managementPage: chatPlugin.managementPage }
          : capabilityPlugin ?? { id: id.slice(pluginProviderPrefix.length), name: id.slice(pluginProviderPrefix.length), managementPage: false }
        : undefined
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
        plugin: plugin ? { id: plugin.id, managementPage: plugin.managementPage } : undefined,
        requestHeaders: this.#requestHeaders.list(id),
        id,
        builtinProviderId: builtin?.builtinProviderId ?? null,
        api: custom?.api ?? null,
        description: custom?.description ?? null,
        displayName: plugin?.name ?? custom?.displayName ?? builtin?.displayName ?? template?.name ?? id,
        baseUrl: custom?.baseUrl ?? provider?.baseUrl ?? null,
        canSyncModels: !plugin && Boolean(provider && syncUnavailableReason === null),
        authTypes: plugin ? [] : provider ? providerAuthTypes(provider) : custom ? ['api_key'] : [],
        storedCredentialType,
        status: plugin ? provider || capabilities.some(item => item.available) ? 'available' : 'unavailable' : !provider || this.#credentialStatus.availability === 'unknown' ? 'unavailable' : storedCredentialType ? 'available' : 'authentication_required',
        custom: Boolean(custom),
        activeRunCount: this.#activeRunsForProvider(id).length,
        added: true,
        enabled,
        enabledModelCount,
        modelCount: modelSummary?.modelCount ?? 0,
        setupComplete: Boolean((provider || capabilities.length) && (plugin || storedCredentialType !== null)),
        syncUnavailableReason: plugin ? 'unsupported_api' : !provider && custom ? 'unsupported_api' : syncUnavailableReason,
      })
    })
    return providers.sort((left, right) => left.displayName.localeCompare(right.displayName))
  }

  isPluginModelEnabled(extensionId: string, modelId: string): boolean {
    const providerId = `plugin:${extensionId}`
    return this.#states.findByProviderId(providerId)?.enabled !== false && this.#modelCatalog.list(providerId).find(model => model.id === modelId)?.enabled !== false
  }

  async listModels(providerId?: string): Promise<readonly BuddyModel[]> {
    await this.#credentialStatus.listOrEmpty()
    return this.#modelCatalog.list(providerId)
  }

  async prepareModelRequest(providerId: string, signal?: AbortSignal): Promise<{ baseUrl: string, headers: Record<string, string> }> {
    const provider = await this.#requireListedProvider(providerId)
    if (!provider.enabled || !provider.baseUrl || provider.plugin)
      throw new ProviderUnavailableError()
    const runtime = this.executionModels.getRuntime()
    const auth = await runtime.getAuth(providerId, { signal })
    if (!auth)
      throw new ProviderAuthenticationRequiredError()
    signal?.throwIfAborted()
    const headers = new Headers()
    if (auth.auth.apiKey)
      headers.set('Authorization', `Bearer ${auth.auth.apiKey}`)
    for (const [name, value] of Object.entries({ ...runtime.getProvider(providerId)?.headers, ...auth.auth.headers })) {
      if (value === null)
        headers.delete(name)
      else
        headers.set(name, value)
    }
    for (const [name, value] of Object.entries(this.#requestHeaders.resolve(providerId, Object.fromEntries(headers), auth.auth.apiKey))) {
      if (value === null)
        headers.delete(name)
      else
        headers.set(name, value)
    }
    return { baseUrl: auth.auth.baseUrl ?? provider.baseUrl, headers: Object.fromEntries(headers) }
  }

  getModelSnapshot(): Promise<ProviderModelSnapshotStatus> {
    return this.#modelSnapshot.getStatus()
  }

  async refreshModelSnapshot(): Promise<ProviderModelSnapshotStatus> {
    return this.#operate('refreshModelSnapshot', async () => {
      await this.#modelSnapshot.refresh()
      await this.#credentialStatus.listOrEmpty()
      for (const instance of this.#builtins.list()) {
        if (this.#modelRuntime.getProvider(instance.id))
          this.#state.commit('metadata', () => this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, { metadataOnly: true }))
      }
      for (const instance of this.#builtins.list()) {
        const baseUrl = this.#modelRuntime.getProvider(instance.id)?.baseUrl
        if (baseUrl)
          this.#state.commit('metadata', () => this.#modelCatalog.reconcileCatalogModels(instance.id, baseUrl, instance.builtinProviderId))
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
      const builtin = this.#builtins.findById(providerId)
      if (!custom && (!builtin || !input.type || input.type === 'chat'))
        throw new ProviderValidationError()
      this.#assertProviderIdle(providerId)
      const model = this.#state.commit('configuration', () => this.#modelCatalog.upsertManualModel(custom ?? { id: providerId, api: 'openai-audio' }, input))
      if (custom)
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

  async setModelType(providerId: string, modelId: string, type: ProviderModelType | null): Promise<BuddyModel> {
    return this.#operate('setModelType', async () => {
      this.#assertProviderIdle(providerId)
      const model = this.#state.commit('configuration', () => {
        const next = this.#modelCatalog.setType(providerId, modelId, type)
        if (next.type !== 'chat')
          this.#clearDefaultIfMatches(providerId, modelId)
        return next
      })
      const custom = this.#configs.findById(providerId)
      if (custom)
        this.#applyCatalog(providerId, () => this.#modelCatalog.registerCustomProvider(custom))
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
      await this.#credentialStatus.listOrEmpty()
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

  async setModelsEnabled(providerId: string, modelIds: readonly string[], enabled: boolean): Promise<BuddyModel[]> {
    return this.#operate('setModelsEnabled', async () => {
      await this.#credentialStatus.listOrEmpty()
      const uniqueIds = [...new Set(modelIds)]
      if (!uniqueIds.length)
        return []
      for (const modelId of uniqueIds)
        this.#modelCatalog.assertCanSetEnabled(providerId, modelId, enabled)
      if (!enabled) {
        for (const modelId of uniqueIds)
          this.#assertModelIdle(providerId, modelId)
      }
      const models = this.#transaction(() => {
        const updated = this.#modelCatalog.setManyEnabled(providerId, uniqueIds, enabled)
        if (!enabled) {
          for (const modelId of uniqueIds)
            this.#clearDefaultIfMatches(providerId, modelId)
        }
        return updated
      })
      // Failed transactions must not enter ProviderState's publish-on-exit boundary.
      return this.#state.commit('configuration', () => models)
    })
  }

  async removeModel(providerId: string, modelId: string): Promise<void> {
    return this.#operate('removeModel', async () => {
      await this.#credentialStatus.listOrEmpty()
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
        const capabilities = this.#capabilityModels.filter(item => item.providerId === providerId && item.available)
        if (!this.#plugins.has(providerId) && !capabilities.some(item => item.plugin)) {
          const credentials = await this.#credentialStatus.list()
          if (!credentials.some(credential => credential.providerId === providerId))
            throw new ProviderAuthenticationRequiredError()
        }
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
    return this.#operate('syncModels', async (generation) => {
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
        this.#assertOperationCurrent(generation)
        if (JSON.stringify(this.#builtins.findById(providerId)) !== JSON.stringify(instance))
          throw new ProviderUnavailableError()
        this.#assertProviderIdle(providerId)
        await this.#reconcileBuiltinModels(instance, true)
        return this.listModels(providerId)
      }
      if (!custom || !this.#modelDiscovery.supports(custom.api))
        throw new ProviderModelSyncUnsupportedError()
      this.#assertProviderIdle(providerId)
      const discovery = await this.#modelDiscovery.discover({
        signal: this.#shutdown.signal,
        api: custom.api,
        baseUrl: custom.baseUrl,
        providerId,
      })
      this.#assertOperationCurrent(generation)
      if (JSON.stringify(this.#configs.findById(providerId)) !== JSON.stringify(custom))
        throw new ProviderUnavailableError()
      this.#assertProviderIdle(providerId)
      this.#state.commit('discovery', () => this.#modelCatalog.reconcileSyncedModels(custom, discovery))
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
    if (providerId.startsWith(pluginProviderPrefix))
      throw new ProviderValidationError()
    return this.#operate('removeProvider', async () => {
      this.#assertProviderIdle(providerId)
      await this.#modelRuntime.logout(providerId)
      this.#assertProviderIdle(providerId)
      this.#state.commit('configuration', () => {
        this.#clearDefaultForProvider(providerId)
        this.#modelCatalog.removeForProvider(providerId)
        this.#resolutionRepository?.remove(providerId)
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
    if (current)
      return
    const now = new Date().toISOString()
    this.#states.upsert({
      createdAt: now,
      enabled,
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
    const generation = this.#operationGeneration
    await this.#credentialStatus.listOrEmpty()
    const models = authenticated
      ? await this.#modelRuntime.getAvailable(instance.id)
      : this.#modelRuntime.getModels(instance.id)
    this.#assertOperationCurrent(generation)
    if (JSON.stringify(this.#builtins.findById(instance.id)) !== JSON.stringify(instance))
      throw new ProviderUnavailableError()
    this.#state.commit('discovery', () => this.#restoreResolution(instance.id, this.#builtinResolutionInput(instance, authenticated, models), () => this.#commitBuiltinModels(instance, authenticated, models), true))
  }

  #commitBuiltinModels(instance: BuiltinProviderConfigRecord, authenticated: boolean, models: readonly Model<Api>[], preserveUnchanged = false): void {
    this.#modelCatalog.reconcileBuiltinModels(instance.id, instance.builtinProviderId, {
      models,
      metadataOnly: !authenticated && this.#modelCatalog.hasModels(instance.id),
      preserveUnchanged,
    })
    const baseUrl = this.#modelRuntime.getProvider(instance.id)?.baseUrl
    if (baseUrl)
      this.#modelCatalog.reconcileCatalogModels(instance.id, baseUrl, instance.builtinProviderId, preserveUnchanged)
  }

  #builtinResolutionInput(instance: BuiltinProviderConfigRecord, authenticated: boolean, models: readonly Model<Api>[]) {
    return {
      kind: 'builtin',
      builtinProviderId: instance.builtinProviderId,
      authenticated,
      credentialType: this.#credentialStatus.type(instance.id),
      baseUrl: this.#modelRuntime.getProvider(instance.id)?.baseUrl,
      channel: Boolean(this.#modelRuntime.getProvider(instance.id)?.auth.oauth),
      models: models.map(model => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        input: model.input,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost,
        compat: model.compat,
        samplingParams: model.samplingParams,
      })).sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  #restoreResolution(providerId: string, input: unknown, reconcile: () => void, force = false): void {
    const fingerprint = modelResolutionFingerprint({ version: MODEL_RESOLUTION_VERSION, catalog: this.#modelCatalog.getFingerprint(), input })
    const restored = !force && this.#resolutionRepository?.find(providerId) === fingerprint
    if (!restored) {
      const apply = () => {
        reconcile()
        this.#modelCatalog.prepareResolutions(providerId)
      }
      if (this.#resolutionRepository)
        this.#resolutionRepository.commit(providerId, fingerprint, apply)
      else
        apply()
    }
    this.#resolutions.fire(Object.freeze({ providerId, restored }))
  }

  #assertOperationCurrent(generation: number): void {
    this.#shutdown.signal.throwIfAborted()
    if (generation !== this.#operationGeneration)
      throw new ProviderUnavailableError()
  }

  #capture() {
    const builtin = new Map(this.#builtins.list().map(provider => [provider.id, provider]))
    const custom = new Map(this.#configs.list().map(provider => [provider.id, provider]))
    return {
      providers: [...new Set([...builtin.keys(), ...custom.keys(), ...this.pluginProviderIds()])].sort().map(id => ({
        id,
        enabled: this.#states.findByProviderId(id)?.enabled ?? false,
        presentation: { name: custom.get(id)?.displayName ?? builtin.get(id)?.displayName, description: custom.get(id)?.description, capabilities: this.#capabilityModels.filter(model => model.providerId === id).map(model => ({ modelId: model.modelId, available: model.available, plugin: model.plugin })) },
        execution: { plugin: this.#plugins.get(id), api: custom.get(id)?.api, baseUrl: custom.get(id)?.baseUrl, builtin: builtin.get(id)?.builtinProviderId, headers: this.#requestHeaders.list(id) },
      })),
      models: this.#modelCatalog.capture().map(({ model, execution }) => ({ model, execution: { ...execution, serviceTiers: this.executionModels.getServiceTiers({ providerId: model.providerId, modelId: model.id, api: model.api }) } })),
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
      const custom = this.#configs.findById(providerId)
      if (custom && this.#resolutionRepository)
        this.#restoreResolution(providerId, { kind: 'custom', api: custom.api, baseUrl: custom.baseUrl, models: custom.models }, () => {})
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
      this.#resolutions.dispose()
      this.#operations.dispose()
      this.#applications.dispose()
      this.#state.dispose()
    })
    return this.#disposal
  }

  #operate<T>(operation: string, work: (generation: number) => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new ProviderUnavailableError())
    const operationId = randomUUID()
    const generation = ++this.#operationGeneration
    const result = Promise.resolve().then(() => {
      this.#shutdown.signal.throwIfAborted()
      if (operation === 'initializeProviders')
        this.#assertOperationCurrent(generation)
      return work(generation)
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
