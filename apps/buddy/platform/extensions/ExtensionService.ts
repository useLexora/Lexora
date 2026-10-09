import type { ExtensionAgentDescriptor, ExtensionAgentInvocation } from '../../shared/extensions/extensionAgent'
import type { ExtensionMenuInvocation, ExtensionResource, ExtensionStatus, ExtensionViewInput, ExtensionViewSession, ExtensionWorkbenchEvent } from '../../shared/extensions/extensionApi'
import type { ExtensionInspection } from '../../shared/extensions/extensionAuthoring'
import type { ExtensionConditionRuntime } from '../../shared/extensions/extensionConditionContext'
import type { ExtensionConditionState } from '../../shared/extensions/extensionConditions'
import type { ExtensionResourceSelection } from '../../shared/extensions/extensionResources'
import type { ExtensionConfiguration, ExtensionConfigurationSnapshot } from '../../shared/extensions/extensionSettings'
import type { SpaceFileTarget } from '../../shared/spaces/spaceFileApi'
import type { WorkbenchPaneSnapshot } from '../../shared/workbench/workbenchInteraction'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionCompiler } from './compileExtensionSource'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import type { ExtensionConfigurationApplication, ExtensionServiceChange, ExtensionServiceFact, ExtensionServiceSnapshot } from './ExtensionServiceEvents'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { Emitter } from '../../shared/events/Emitter'
import { copyEventSnapshot } from '../../shared/events/eventSnapshot'
import { extensionAgentInvocationLimits, extensionAgentRequestSchema } from '../../shared/extensions/extensionAgent'
import { extensionAgentCapabilities } from '../../shared/extensions/extensionAgentCapabilities'
import { extensionError, extensionJsonSchema, extensionResourceSchema } from '../../shared/extensions/extensionApi'
import { EXTENSION_CATALOG_URL } from '../../shared/extensions/extensionCatalog'
import { extensionConditionInvalidationSchema } from '../../shared/extensions/extensionConditions'
import { extensionCompatible, extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { extensionDirectoryScanSchema, extensionResourceSelectionSchema } from '../../shared/extensions/extensionResources'
import { extensionNotificationSchema, extensionScheduleIdSchema, extensionScheduleInputSchema } from '../../shared/extensions/extensionSchedule'
import { extensionConfigurationAppliedSchema, resolveExtensionConfiguration, validateExtensionSetting } from '../../shared/extensions/extensionSettings'
import { workbenchHitRegionsSchema } from '../../shared/workbench/workbenchInteraction'
import { controlProposalSchema, extensionPresentationRequestSchema } from '../../shared/workbench/workbenchUi'
import { publicWebUrl, readResponseBytes } from '../network/publicWebTransport'
import { ExtensionCatalogService } from './ExtensionCatalogService'
import { ExtensionConditionInvalidatedError } from './ExtensionConditionEvaluator'
import { ExtensionConditions } from './ExtensionConditions'
import { sha256, unpackExtension } from './extensionFiles'
import { ExtensionInstallations } from './ExtensionInstallations'
import { extensionActivationOrder } from './ExtensionPackageStore'
import { ExtensionResourceWriter } from './ExtensionResourceWriter'
import { ExtensionScheduler } from './ExtensionScheduler'

export interface ExtensionHost {
  call: (method: string, params: JsonValue) => Promise<JsonValue>
  dispose: () => Promise<void>
  devtools: () => void
}
export interface ExtensionServicePorts {
  createHost: (pkg: ExtensionPackage, broker: (method: string, params: unknown) => Promise<JsonValue>, failed: () => void) => ExtensionHost
  createView: (pkg: ExtensionPackage) => { token: string, url: string, dispose: () => void }
  workbench: (event: ExtensionWorkbenchEvent, signal: AbortSignal) => Promise<string | null>
  readText: (target: SpaceFileTarget, signal: AbortSignal) => Promise<string>
  get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  changed?: () => void
  agentChanged?: () => void
  conditionRuntime?: (input: { models: boolean, task: boolean, taskId: string | null, runId: string | null }, signal: AbortSignal) => Promise<ExtensionConditionRuntime>
  agentRequest?: (input: { invocationId: string, method: string, params: JsonValue }, signal: AbortSignal) => Promise<JsonValue>
  notify?: (id: string, notification: { title: string, body: string }) => boolean
  compile?: ExtensionCompiler
  selectResources?: (name: string, selection: ExtensionResourceSelection & { directory?: boolean }, signal: AbortSignal) => Promise<string[]>
  selectSavePath?: (name: string, suggestedName: string, signal: AbortSignal) => Promise<string | null>
}
interface RunningExtension {
  package: ExtensionPackage
  generation: string
  abort: AbortController
  host: ExtensionHost
  ready: Promise<void>
  active: boolean
  inFlight: number
  drained: Set<() => void>
  panesPending?: boolean
}
interface RunningView {
  input: ExtensionViewInput
  session: ExtensionViewSession
  running: RunningExtension
  dispose: () => void
  abort: AbortController
  ready: boolean
  error: string | null
  writers: Map<string, ExtensionResourceWriter>
}

export class ExtensionService {
  readonly #changes = new Emitter<ExtensionServiceChange>(() => console.error('EXTENSION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #configurationApplications = new Map<string, ExtensionConfigurationApplication>()
  #revision = 0
  readonly conditions: ExtensionConditions
  readonly store: ExtensionPackageStore
  readonly scheduler: ExtensionScheduler
  readonly installations: ExtensionInstallations
  readonly catalog: ExtensionCatalogService
  readonly #reviews = new Map<string, string>()
  readonly #ports: ExtensionServicePorts
  readonly #running = new Map<string, RunningExtension>()
  readonly #viewOpenings = new Map<string, symbol>()
  readonly #views = new Map<string, RunningView>()
  readonly #diagnostics = new Map<string, Pick<ExtensionStatus, 'error' | 'activationMs' | 'logs'>>()
  readonly #notificationTimes = new Map<string, number>()
  readonly #interactions = new Map<string, { running: RunningExtension, title: string, abort: AbortController }>()
  readonly #agentInvocations = new Map<string, { running: RunningExtension, signal: AbortSignal, abort: AbortController }>()
  readonly #stopping = new Set<Promise<void>>()
  readonly #retired = new Set<RunningExtension>()
  readonly #viewRequests = new Set<Promise<JsonValue>>()
  readonly #viewCleanups = new Set<Promise<void>>()
  #viewCleanupError: Error | undefined
  #agentDescriptors: ExtensionAgentDescriptor[] = []
  #agentFingerprint = ''
  #agentRefreshing = Promise.resolve()
  #panes: WorkbenchPaneSnapshot[] = []
  #loading: Promise<void> | undefined
  #mutating = Promise.resolve()
  #compiling = Promise.resolve()
  #disposed = false
  #disposal: Promise<void> | undefined
  #epoch = 0

  constructor(store: ExtensionPackageStore, ports: ExtensionServicePorts) {
    this.store = store
    this.#ports = ports
    this.conditions = new ExtensionConditions({
      package: async (id) => {
        await this.initialize()
        await this.#mutating
        this.#order(id)
        return this.store.installed[id]!.current
      },
      packages: () => Object.values(this.store.installed).filter(record => record.enabled).map(record => record.current),
      configuration: id => this.store.configurationSnapshot(id),
      activate: async (id) => {
        const running = await this.#activate(id)
        return { generation: running.generation, host: running.host, signal: running.abort.signal }
      },
      runtime: ports.conditionRuntime,
      workbench: () => this.#panes.map(({ id, active, visible }) => ({ id, active, visible })),
    })
    this.onDidChange((change) => {
      ports.changed?.()
      if (change.kind === 'contributions' && !change.initial)
        ports.agentChanged?.()
    })
    this.installations = new ExtensionInstallations(store.root, () => this.#publish({ kind: 'installation-progress' }))
    this.catalog = new ExtensionCatalogService(store.root, store.appVersion, ports.get)
    this.scheduler = new ExtensionScheduler(store.root, {
      available: (id, command) => {
        if (this.#disposed || this.#diagnostics.get(id)?.error)
          return false
        try {
          this.#order(id)
          const manifest = this.store.installed[id]!.current.manifest
          return manifest.permissions.schedules && manifest.contributes.commands.some(item => item.id === command)
        }
        catch {
          return false
        }
      },
      execute: (id, command) => this.execute(id, command, null),
      failed: (id, error) => this.#log(id, 'schedule.failed', extensionError(error)),
    })
  }

  get snapshot(): ExtensionServiceSnapshot {
    return copyEventSnapshot({
      revision: this.#revision,
      extensions: Object.entries(this.store.installed).map(([id, installed]) => ({
        id,
        enabled: installed.enabled,
        packageRevision: installed.current.revision,
        pendingRevision: installed.pending?.revision ?? null,
        generation: this.#running.get(id)?.generation ?? null,
        active: this.#running.get(id)?.active ?? false,
        errorCode: this.#diagnostics.get(id)?.error ?? null,
        configuration: this.#configurationApplications.get(id) ?? null,
      })),
      contributions: this.#agentDescriptors,
      views: [...this.#views.values()].map(view => ({ viewId: view.input.viewId, extensionId: view.input.extensionId, generation: view.running.generation, ready: view.ready, errorCode: view.error })),
    })
  }

  async initialize(): Promise<void> {
    await (this.#loading ??= this.store.load().then(async () => {
      await this.installations.load()
      await this.scheduler.load()
      await this.#refreshAgentContributions(false)
    }))
  }

  async list(): Promise<ExtensionStatus[]> {
    await this.initialize()
    return Promise.all(Object.entries(this.store.installed).map(async ([id, record]): Promise<ExtensionStatus> => {
      const diagnostics = this.#diagnostics.get(id) ?? { error: null, activationMs: null, logs: [] }
      const running = this.#running.get(id)
      let blocked: string | null = null
      if (record.enabled) {
        try {
          this.#order(id)
        }
        catch (error) {
          blocked = extensionError(error)
        }
      }
      return { source: record.current.source ?? undefined, manifest: record.current.manifest, iconUrl: await this.store.icon(record.current), revision: record.current.revision, enabled: record.enabled, development: record.development, compatible: extensionCompatible(record.current.manifest, this.store.appVersion), pending: record.pending ? { manifest: record.pending.manifest, revision: record.pending.revision } : null, ...diagnostics, error: blocked ?? diagnostics.error, generation: running?.generation ?? null, state: !record.enabled ? 'disabled' : blocked ? 'blocked' : running ? running.active ? 'active' : 'activating' : diagnostics.error ? 'failed' : 'inactive' }
    }))
  }

  async inspect(id: string): Promise<ExtensionInspection> {
    const item = (await this.list()).find(item => item.manifest.id === id)
    return {
      id,
      installed: !!item,
      version: item?.manifest.version ?? null,
      pendingVersion: item?.pending?.manifest.version ?? null,
      enabled: item?.enabled ?? false,
      state: item?.state ?? 'not-installed',
      error: item?.error ?? null,
      commands: item?.manifest.contributes.commands.filter(command => !command.hidden).map(({ id, title }) => ({ id, title })) ?? [],
      navigation: item?.manifest.contributes.navigation?.title ?? null,
      views: [...this.#views.values()].filter(view => view.input.extensionId === id).map(view => ({ type: view.input.viewType, placement: view.input.placementId ?? null, ready: view.ready, error: view.error })),
      installations: this.installations.list().filter(record => record.extensionId === id).slice(0, 5).map(record => ({ version: record.version!, status: record.status, stage: record.stage, error: record.error })),
      logs: item?.logs ?? [],
    }
  }

  async configuration(id: string): Promise<ExtensionConfiguration> {
    await this.initialize()
    await this.#mutating
    return this.store.configuration(id)
  }

  async configurationSnapshot(id: string): Promise<ExtensionConfigurationSnapshot> {
    await this.initialize()
    await this.#mutating
    return this.store.configurationSnapshot(id)
  }

  async configure(id: string, patch: ExtensionConfiguration): Promise<void> {
    await this.#mutate(async () => {
      const manifest = this.store.installed[id]?.current.manifest
      if (!manifest)
        throw new Error('EXTENSION_NOT_INSTALLED')
      const { values: current } = await this.store.configurationSnapshot(id)
      const changedKeys: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        const item = manifest.contributes.settings.items.find(item => item.key === key)
        if (!item)
          throw new Error('EXTENSION_CONFIGURATION_INVALID')
        const validated = validateExtensionSetting(item, value)
        if (JSON.stringify(current[key]) !== JSON.stringify(validated)) {
          current[key] = validated
          changedKeys.push(key)
        }
      }
      if (!changedKeys.length)
        return
      await this.store.saveConfiguration(id, current)
      this.conditions.invalidate({ extensionId: id, inputs: ['configuration', 'form'] })
      const operationId = randomUUID()
      const configurationRevision = sha256(JSON.stringify(current))
      const running = this.#running.get(id)
      const application = { operationId, configurationRevision, generation: running?.generation ?? null }
      if (this.#diagnostics.get(id)?.error === 'EXTENSION_CONFIGURATION_INVALID')
        this.#clearError(id)
      this.#configurationChanged(id, { ...application, status: 'committed' }, changedKeys)
      for (const invocation of this.#agentInvocations.values()) {
        if (invocation.running.package.manifest.id === id)
          invocation.abort.abort()
      }
      if (running?.active && !resolveExtensionConfiguration(manifest.contributes.settings.items, current).invalidKeys.length) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([
            running.host.call('configuration.changed', { configuration: current, changedKeys, operationId, generation: running.generation, configurationRevision }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('EXTENSION_CONFIGURATION_UPDATE_TIMEOUT')), 15000) }),
          ])
          this.#assertCurrent(running)
          const applied = extensionConfigurationAppliedSchema.parse(result)
          if (applied.operationId !== operationId || applied.generation !== running.generation || applied.configurationRevision !== configurationRevision)
            throw new Error('EXTENSION_CONFIGURATION_UPDATE_STALE')
          if (applied.applied) {
            this.#configurationChanged(id, { ...application, status: 'applied' }, changedKeys)
            return
          }
        }
        catch (error) {
          const code = extensionError(error)
          this.#log(id, 'configuration.update-failed', code)
          this.#configurationChanged(id, { ...application, status: 'apply-failed' }, changedKeys, code)
        }
        finally { clearTimeout(timer) }
      }
      try {
        await this.#stopClosure(id)
      }
      finally { this.#configurationChanged(id, { ...application, status: running ? 'invalidated' : 'deferred' }, changedKeys) }
    })
  }

  async agentContributions(): Promise<ExtensionAgentDescriptor[]> {
    await this.initialize()
    await this.#mutating
    await this.#refreshAgentContributions()
    return structuredClone(this.#agentDescriptors)
  }

  async #readAgentContributions(): Promise<ExtensionAgentDescriptor[]> {
    if (this.#disposed)
      return []
    const result: ExtensionAgentDescriptor[] = []
    for (const [id, record] of Object.entries(this.store.installed)) {
      const { manifest, revision } = record.current
      const agent = manifest.contributes.agent
      if (!agent || !record.enabled || this.#diagnostics.get(id)?.error)
        continue
      try {
        this.#order(id)
        const configuration = await this.store.configuration(id)
        if (typeof agent.enabledWhen === 'string' && configuration[agent.enabledWhen] !== true)
          continue
        result.push({ id, name: manifest.name, revision, configurationRevision: sha256(JSON.stringify(configuration)), agent })
      }
      catch {}
    }
    return this.#disposed ? [] : result
  }

  #refreshAgentContributions(notify = true): Promise<void> {
    const refresh = this.#agentRefreshing.catch(() => {}).then(async () => {
      const descriptors = await this.#readAgentContributions()
      const fingerprint = JSON.stringify(descriptors.map(item => [item.id, item.revision, item.configurationRevision]).sort(([a], [b]) => a!.localeCompare(b!)))
      const changed = fingerprint !== this.#agentFingerprint
      this.#agentDescriptors = descriptors
      this.#agentFingerprint = fingerprint
      if (changed)
        this.#publish({ kind: 'contributions', initial: !notify, descriptors })
    })
    this.#agentRefreshing = refresh
    return refresh
  }

  async invokeAgent(input: ExtensionAgentInvocation, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const contribution = (await this.agentContributions()).find(item => item.id === input.extensionId)
    if (!contribution || contribution.revision !== input.revision || contribution.configurationRevision !== input.configurationRevision || !('tool' in input ? contribution.agent.tools.some(tool => tool.id === input.tool) : contribution.agent.actions.some(action => action.id === input.action && action.triggers.includes(input.cause.type))))
      throw Object.assign(new Error('EXTENSION_AGENT_UNAVAILABLE'), { code: 'EXTENSION_AGENT_UNAVAILABLE' })
    const running = await this.#activate(input.extensionId)
    const current = (await this.agentContributions()).find(item => item.id === input.extensionId)
    if (!current || current.revision !== input.revision || current.configurationRevision !== input.configurationRevision)
      throw Object.assign(new Error('EXTENSION_AGENT_UNAVAILABLE'), { code: 'EXTENSION_AGENT_UNAVAILABLE' })
    const references = [
      ...(typeof current.agent.enabledWhen === 'object' ? [{ reference: current.agent.enabledWhen, target: { kind: 'agent' as const, id: current.id } }] : []),
      ...('action' in input ? current.agent.actions.filter(action => action.id === input.action && action.enabledWhen).map(action => ({ reference: action.enabledWhen!, target: { kind: 'action' as const, id: action.id } })) : []),
    ]
    for (const { reference, target } of references) {
      if (!input.context)
        throw new Error('EXTENSION_CONDITION_UNAVAILABLE')
      let state: ExtensionConditionState
      for (let attempt = 0; ; attempt++) {
        try {
          state = await this.conditions.evaluate(running.package, reference, target, { kind: 'task', ...input.context }, { cache: false, signal })
          break
        }
        catch (error) {
          if (!(error instanceof ExtensionConditionInvalidatedError))
            throw error
          signal.throwIfAborted()
          this.#assertCurrent(running)
          if (attempt > 0)
            throw Object.assign(new Error('EXTENSION_AGENT_CANCELLED'), { code: 'EXTENSION_AGENT_CANCELLED' })
        }
      }
      signal.throwIfAborted()
      this.#assertCurrent(running)
      if (!state.value) {
        if (state.status === 'ready' && 'action' in input)
          return { status: 'skipped', ...(state.reason ? { message: state.reason } : {}) }
        throw new Error('EXTENSION_CONDITION_UNAVAILABLE')
      }
    }
    if (references.length && (await this.agentContributions()).find(item => item.id === input.extensionId)?.configurationRevision !== input.configurationRevision)
      throw new Error('EXTENSION_AGENT_UNAVAILABLE')
    const controller = new AbortController()
    const abort = AbortSignal.any([signal, running.abort.signal, controller.signal, AbortSignal.timeout(120000)])
    abort.throwIfAborted()
    if (this.#agentInvocations.has(input.invocationId) || [...this.#agentInvocations.values()].filter(item => item.running === running).length >= extensionAgentInvocationLimits.concurrentPerExtension)
      throw new Error('EXTENSION_REQUEST_LIMIT')
    this.#agentInvocations.set(input.invocationId, { running, signal: abort, abort: controller })
    const cancel = () => {
      void running.host.call('agent.cancel', { invocationId: input.invocationId }).catch(() => {})
    }
    abort.addEventListener('abort', cancel, { once: true })
    try {
      const result = await running.host.call('agent.invoke', { invocationId: input.invocationId, ...('tool' in input ? { tool: input.tool, input: input.input } : { action: input.action, cause: input.cause }) })
      abort.throwIfAborted()
      this.#assertCurrent(running)
      return extensionJsonSchema.parse(result)
    }
    catch (error) {
      if (abort.aborted)
        throw Object.assign(new Error('EXTENSION_AGENT_CANCELLED'), { code: 'EXTENSION_AGENT_CANCELLED' })
      throw error
    }
    finally {
      abort.removeEventListener('abort', cancel)
      this.#agentInvocations.delete(input.invocationId)
    }
  }

  async review(path: string, development = false) {
    await this.initialize()
    const job = this.installations.begin(basename(path), 'validate')
    try {
      const review = await this.store.review(path, development)
      this.installations.identify(job.id, review.manifest.id, review.manifest.version)
      job.signal.throwIfAborted()
      this.#reviews.set(review.token, job.id)
      this.installations.log(job.id, 'review', 'permissions')
      return { ...review, installationId: job.id }
    }
    catch (error) {
      this.installations.failed(job.id, error)
      throw error
    }
  }

  cancelInstall(token: string): void {
    const id = this.#reviews.get(token)
    if (id)
      this.installations.cancel(id)
    this.store.cancelReview(token)
    this.#reviews.delete(token)
  }

  async reviewCatalog(id: string, version: string) {
    await this.initialize()
    const job = this.installations.begin(id, 'download')
    try {
      const { entry, bytes } = await this.catalog.download(id, version, job.signal)
      this.installations.log(job.id, 'validate', 'checksum')
      const files = unpackExtension(bytes)
      const manifest = extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(files.get('extension.json'))))
      if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest))
        throw new Error('EXTENSION_CATALOG_MANIFEST_MISMATCH')
      job.signal.throwIfAborted()
      const source = { catalog: EXTENSION_CATALOG_URL, artifact: entry.artifact.url, sha256: entry.artifact.sha256 }
      const review = await this.store.reviewFiles(files, false, source)
      this.installations.identify(job.id, review.manifest.id, review.manifest.version)
      this.#reviews.set(review.token, job.id)
      this.installations.log(job.id, 'review', 'permissions')
      return { ...review, installationId: job.id, source }
    }
    catch (error) {
      this.installations.failed(job.id, error)
      throw error
    }
  }

  async install(token: string): Promise<void> {
    await this.initialize()
    const job = this.#reviews.get(token) ?? this.installations.begin('Plugin', 'compile').id
    try {
      const signal = this.installations.signal(job)
      this.installations.log(job, 'compile', 'checking')
      const preparing = this.#compiling.then(() => this.store.prepare(token, this.#ports.compile, signal, message => this.installations.log(job, 'compile', message)))
      this.#compiling = preparing.then(() => {}, () => {})
      const compiled = await preparing
      this.installations.log(job, 'compile', compiled ? 'compiled' : 'skipped')
      await this.#mutate(async () => {
        signal.throwIfAborted()
        this.installations.log(job, 'install', 'installing')
        const id = await this.store.install(token, signal)
        const installed = this.store.installed[id]!
        this.#publish({ kind: 'package', action: 'installed', extensionId: id, packageRevision: installed.current.revision, ...(installed.pending ? { pendingRevision: installed.pending.revision } : {}) })
        this.#log(id, 'installed')
      })
      this.installations.log(job, 'completed', 'installed')
    }
    catch (error) {
      this.store.cancelReview(token)
      this.installations.failed(job, error)
      throw error
    }
    finally {
      this.#reviews.delete(token)
    }
  }

  enable(id: string, enabled: boolean): Promise<void> {
    return this.#mutate(async () => {
      const previous = this.store.installed[id]?.enabled
      await this.store.enable(id, enabled)
      if (previous !== enabled)
        this.#publish({ kind: 'enabled', extensionId: id, enabled })
      if (!enabled)
        await this.#stopClosure(id)
      this.#clearError(id)
      await this.scheduler.resume()
      this.#log(id, enabled ? 'enabled' : 'disabled')
    })
  }

  restart(id: string): Promise<void> {
    return this.#mutate(async () => {
      if (!this.store.installed[id])
        throw new Error('EXTENSION_NOT_INSTALLED')
      await this.#stopClosure(id)
      const previousRevision = this.store.installed[id]!.current.revision
      await this.store.promote(id)
      if (this.store.installed[id]!.current.revision !== previousRevision)
        this.#publish({ kind: 'package', action: 'promoted', extensionId: id, packageRevision: this.store.installed[id]!.current.revision })
      this.#clearError(id)
      await this.scheduler.resume()
      this.#log(id, 'restarted')
    })
  }

  revokeResources(id: string): Promise<void> {
    return this.#mutate(async () => {
      await this.store.resources.revoke(id)
      this.#publish({ kind: 'resources-revoked', extensionId: id })
      await this.#stopClosure(id)
      this.#log(id, 'resources.revoked')
    })
  }

  uninstall(id: string, clearData = false): Promise<void> {
    return this.#mutate(async () => {
      const record = this.store.installed[id]
      if (!record)
        throw new Error('EXTENSION_NOT_INSTALLED')
      await this.store.enable(id, false)
      if (record.enabled)
        this.#publish({ kind: 'enabled', extensionId: id, enabled: false })
      await this.#stopClosure(id)
      await this.store.resources.revoke(id)
      this.#publish({ kind: 'resources-revoked', extensionId: id })
      await this.scheduler.remove(id)
      if (clearData) {
        const requestId = randomUUID()
        const cleared = await this.#ports.workbench({ kind: 'clear-data', requestId, extensionId: id }, AbortSignal.timeout(10000))
        if (cleared !== requestId)
          throw new Error('EXTENSION_DATA_CLEANUP_FAILED')
        await this.store.removeData(id)
      }
      await this.store.removePackages(id)
      await this.store.uninstall(id)
      this.#diagnostics.delete(id)
      this.#configurationApplications.delete(id)
      this.#publish({ kind: 'package', action: 'uninstalled', extensionId: id })
    })
  }

  async devtools(id: string): Promise<void> {
    if (!this.store.installed[id]?.development)
      throw new Error('EXTENSION_METHOD_DENIED')
    const running = await this.#activate(id)
    running.host.devtools()
  }

  async execute(id: string, command: string, target: SpaceFileTarget | null): Promise<void> {
    const running = await this.#activate(id)
    await this.#executeCommand(running, command, target)
  }

  updatePanes(panes: WorkbenchPaneSnapshot[]): void {
    const changed = JSON.stringify(this.#panes.map(({ id, active, visible }) => ({ id, active, visible }))) !== JSON.stringify(panes.map(({ id, active, visible }) => ({ id, active, visible })))
    this.#panes = structuredClone(panes)
    if (changed)
      this.conditions.invalidate({ inputs: ['workbench'] })
    for (const running of this.#running.values()) {
      if (running.active)
        this.#publishPanes(running)
    }
  }

  #publishPanes(running: RunningExtension): void {
    if (running.package.manifest.apiVersion < 3 || running.panesPending || running.abort.signal.aborted)
      return
    const panes = this.#panes
    running.panesPending = true
    void running.host.call('panes', { panes }).catch(() => {}).finally(() => {
      running.panesPending = false
      if (panes !== this.#panes)
        this.#publishPanes(running)
    })
  }

  async executeSlash(id: string, command: string, argumentsText: string, instanceId?: string): Promise<JsonValue> {
    const running = await this.#activate(id)
    const contribution = running.package.manifest.contributes.commands.find(item => item.id === command)
    if (!contribution?.slash || contribution.hidden)
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    if (instanceId && !this.#panes.some(pane => pane.id === instanceId && pane.visible))
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    return this.#executeCommand(running, command, null, { target: 'slash', instanceId: instanceId ?? null }, argumentsText)
  }

  async endInteraction(id: string): Promise<void> {
    const interaction = this.#interactions.get(id)
    if (!interaction)
      return
    this.#interactions.delete(id)
    interaction.abort.abort()
    for (const view of this.#views.values()) {
      if (view.input.interactionId === id) {
        this.#closeView(view)
      }
    }
    const { running } = interaction
    const removing = this.#ports.workbench({ kind: 'interaction', requestId: randomUUID(), extensionId: running.package.manifest.id, generation: running.generation, interactionId: id, title: null }, AbortSignal.timeout(10000))
    if (!running.abort.signal.aborted)
      void running.host.call('interactionEnded', { id }).catch(() => {})
    await removing
  }

  async executeMenu(id: string, menuId: string, input: ExtensionMenuInvocation): Promise<JsonValue> {
    const running = await this.#activate(id)
    const menu = running.package.manifest.contributes.menus.find(menu => menu.id === menuId && menu.target === input.target)
    if (!menu)
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    const invocation = { target: input.target, instanceId: input.instanceId ?? null, ...(running.package.manifest.permissions.selectedContent && ['composer.actions', 'message.actions'].includes(input.target) && input.content !== undefined ? { content: input.content } : {}) }
    return this.#executeCommand(running, menu.command, input.target === 'resource.actions' ? input.resource : null, invocation)
  }

  async #executeCommand(running: RunningExtension, command: string, target: SpaceFileTarget | null, invocation: JsonValue = null, argumentsValue: JsonValue = null): Promise<JsonValue> {
    if (!running.package.manifest.contributes.commands.some(item => item.id === command))
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    let resource: ExtensionResource | null = null
    if (target && running.package.manifest.permissions.selectedResource === 'read') {
      await this.#ports.readText(target, running.abort.signal)
      this.#assertCurrent(running)
      resource = await this.store.grant(running.package.manifest.id, target, () => this.#assertCurrent(running))
    }
    this.#assertCurrent(running)
    const result = await running.host.call('command', { command, resource, arguments: argumentsValue, invocation })
    this.#assertCurrent(running)
    return extensionJsonSchema.parse(result)
  }

  async openView(input: ExtensionViewInput): Promise<ExtensionViewSession> {
    const request = Symbol('view-open')
    this.#viewOpenings.set(input.viewId, request)
    try {
      const running = await this.#activate(input.extensionId)
      const view = running.package.manifest.contributes.views.find(item => item.id === input.viewType)
      if (!view)
        throw new Error('EXTENSION_VIEW_UNAVAILABLE')
      if (input.placementId && !running.package.manifest.contributes.placements.some(placement => placement.id === input.placementId && placement.view === view.id))
        throw new Error('EXTENSION_PLACEMENT_UNAVAILABLE')
      if (view.resource === 'selected-file' && !input.resource)
        throw new Error('EXTENSION_RESOURCE_REQUIRED')
      if (input.interactionId) {
        const interaction = this.#interactions.get(input.interactionId)
        const placement = running.package.manifest.contributes.placements.find(item => item.id === input.placementId)
        if (interaction?.running !== running || placement?.kind !== 'view' || !placement.interaction)
          throw new Error('EXTENSION_INTERACTION_ENDED')
      }
      else if (running.package.manifest.contributes.placements.some(item => item.id === input.placementId && item.kind === 'view' && item.interaction)) {
        throw new Error('EXTENSION_INTERACTION_REQUIRED')
      }
      if (input.resource)
        await this.#resource(running, input.resource.id)
      this.#assertCurrent(running)
      if (input.interactionId && !this.#interactions.has(input.interactionId))
        throw new Error('EXTENSION_INTERACTION_ENDED')
      if (this.#viewOpenings.get(input.viewId) !== request)
        throw new Error('EXTENSION_VIEW_EXPIRED')
      const old = this.#views.get(input.viewId)
      if (old)
        this.#closeView(old)
      const endpoint = this.#ports.createView(running.package)
      const abort = new AbortController()
      const writers = new Map<string, ExtensionResourceWriter>()
      const session = { id: input.viewId, extensionId: input.extensionId, generation: running.generation, token: endpoint.token, url: endpoint.url }
      this.#views.set(input.viewId, { input: structuredClone(input), session: structuredClone(session), running, abort, ready: false, error: null, writers, dispose: () => endpoint.dispose() })
      this.#publish({ kind: 'view', extensionId: input.extensionId, generation: running.generation, viewId: input.viewId, status: 'opened' })
      return structuredClone(session)
    }
    finally {
      if (this.#viewOpenings.get(input.viewId) === request)
        this.#viewOpenings.delete(input.viewId)
    }
  }

  closeView(id: string, generation: string, token: string): void {
    const view = this.#views.get(id)
    if (view?.session.generation === generation && view.session.token === token) {
      this.#closeView(view)
    }
  }

  viewRequest(id: string, generation: string, token: string, method: string, params: JsonValue): Promise<JsonValue> {
    const pending = Promise.resolve().then(() => this.#viewRequest(id, generation, token, method, params)).finally(() => this.#viewRequests.delete(pending))
    this.#viewRequests.add(pending)
    return pending
  }

  async #viewRequest(id: string, generation: string, token: string, method: string, params: JsonValue): Promise<JsonValue> {
    const view = this.#views.get(id)
    if (!view || view.session.generation !== generation || view.session.token !== token)
      throw new Error('EXTENSION_VIEW_EXPIRED')
    this.#assertCurrent(view.running)
    const contribution = view.running.package.manifest.contributes.views.find(item => item.id === view.input.viewType)!
    const placement = view.running.package.manifest.contributes.placements.find(placement => placement.id === view.input.placementId)
    let result: JsonValue
    if (method === 'bootstrap') {
      result = { apiVersion: view.running.package.manifest.apiVersion, instanceId: view.input.instanceId ?? null, interactionId: view.input.interactionId ?? null, interactionMode: placement?.kind === 'view' ? placement.interaction ?? null : null, entry: contribution.entry, location: placement?.kind === 'view' ? 'mount' : contribution.location, presentation: placement?.kind ?? (contribution.location === 'window-overlay' ? 'decoration' : 'view'), resource: view.input.resource, state: view.input.state, stateVersion: view.input.stateVersion, expectedStateVersion: contribution.stateVersion }
    }
    else if (method === 'view.setActive') {
      if (placement?.kind !== 'slot' && placement?.kind !== 'control')
        throw new Error('EXTENSION_METHOD_DENIED')
      const { active } = z.object({ active: z.boolean() }).strict().parse(params)
      const accepted = await this.#ports.workbench({ kind: 'activity', requestId: randomUUID(), viewId: id, generation, token, active }, view.abort.signal)
      if (accepted !== id)
        throw new Error('EXTENSION_VIEW_UNAVAILABLE')
      result = null
    }
    else if (method === 'view.setState') {
      if (contribution.location !== 'context' || (placement && placement.kind !== 'view'))
        throw new Error('EXTENSION_METHOD_DENIED')
      const state = extensionJsonSchema.parse(params)
      const saved = await this.#ports.workbench({ kind: 'state', requestId: randomUUID(), viewId: id, generation, token, state, stateVersion: contribution.stateVersion }, view.running.abort.signal)
      if (saved !== id)
        throw new Error('EXTENSION_STATE_SAVE_FAILED')
      view.input = { ...view.input, state, stateVersion: contribution.stateVersion }
      result = null
    }
    else if (method === 'control.propose') {
      if (placement?.kind !== 'control' || !view.running.package.manifest.permissions.controls.includes(placement.target))
        throw new Error('EXTENSION_METHOD_DENIED')
      const proposal = controlProposalSchema.parse(params)
      const accepted = await this.#ports.workbench({ kind: 'control', requestId: randomUUID(), viewId: id, generation, token, proposal }, view.running.abort.signal)
      if (accepted !== id)
        throw new Error('EXTENSION_CONTROL_STALE')
      result = null
    }
    else if (method === 'view.setPresentation') {
      if (placement?.kind !== 'view')
        throw new Error('EXTENSION_METHOD_DENIED')
      const presentation = extensionPresentationRequestSchema.parse(params)
      if (placement.interaction && ((presentation.target && !['workbench', 'workbench.pane'].includes(presentation.target)) || presentation.position === 'static'))
        throw new Error('EXTENSION_METHOD_DENIED')
      const saved = await this.#ports.workbench({ kind: 'presentation', requestId: randomUUID(), viewId: id, generation, token, presentation }, view.running.abort.signal)
      if (saved !== id)
        throw new Error('EXTENSION_PRESENTATION_FAILED')
      result = null
    }
    else if (method === 'view.ready') {
      if (!view.ready) {
        view.ready = true
        this.#publish({ kind: 'view', extensionId: view.input.extensionId, generation, viewId: id, status: 'ready' })
      }
      result = null
    }
    else if (method === 'view.failed') {
      const failure = z.object({ code: z.enum(['EXTENSION_VIEW_FAILED', 'EXTENSION_VIEW_TIMEOUT']) }).safeParse(params)
      view.error = failure.success ? failure.data.code : 'EXTENSION_VIEW_FAILED'
      this.#publish({ kind: 'view', extensionId: view.input.extensionId, generation, viewId: id, status: 'failed', errorCode: view.error })
      this.#log(view.input.extensionId, 'view.failed', failure.success ? failure.data.code : 'EXTENSION_VIEW_FAILED')
      result = null
    }
    else if (['resources.beginSave', 'resources.writeChunk', 'resources.commitSave', 'resources.cancelSave'].includes(method)) {
      if (!view.running.package.manifest.permissions.resourceExport || placement?.kind === 'decoration' || contribution.location === 'window-overlay')
        throw new Error('EXTENSION_RESOURCE_EXPORT_DENIED')
      const assertView = () => {
        this.#assertCurrent(view.running)
        if (view.abort.signal.aborted || this.#views.get(id) !== view)
          throw new Error('EXTENSION_VIEW_EXPIRED')
      }
      if (method === 'resources.beginSave') {
        if (!this.#ports.selectSavePath || view.writers.size >= 2)
          throw new Error('EXTENSION_RESOURCE_SAVE_UNAVAILABLE')
        const input = z.object({ name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/), size: z.number().int().min(0).max(2 * 1024 ** 3) }).strict().parse(params)
        const signal = AbortSignal.any([view.abort.signal, view.running.abort.signal, AbortSignal.timeout(120000)])
        const path = await this.#ports.selectSavePath(view.running.package.manifest.name, input.name, signal)
        signal.throwIfAborted()
        assertView()
        if (path) {
          const writer = await ExtensionResourceWriter.create(path, input.size, assertView)
          try {
            assertView()
          }
          catch (error) {
            await writer.dispose()
            throw error
          }
          view.writers.set(writer.id, writer)
          result = writer.id
        }
        else { result = null }
      }
      else {
        const input = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).optional(), base64: z.string().max(128 * 1024).regex(/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i).optional() }).strict().parse(params)
        const writer = view.writers.get(input.id)
        if (!writer)
          throw new Error('EXTENSION_RESOURCE_WRITE_EXPIRED')
        if (method === 'resources.writeChunk') {
          if (input.offset === undefined || input.base64 === undefined)
            throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
          await writer.append(input.offset, input.base64)
        }
        else {
          try {
            if (method === 'resources.commitSave')
              await writer.commit()
          }
          finally {
            view.writers.delete(input.id)
            await writer.dispose()
          }
        }
        result = null
      }
    }
    else if (method.startsWith('resources.') && (method !== 'resources.readText' || !view.input.resource || !params || typeof params !== 'object' || Array.isArray(params) || params.id !== view.input.resource.id)) {
      if (!view.running.package.manifest.permissions.localResources || placement?.kind === 'decoration' || contribution.location === 'window-overlay')
        throw new Error('EXTENSION_RESOURCE_DENIED')
      const extensionId = view.input.extensionId
      const assertView = () => {
        this.#assertCurrent(view.running)
        if (view.abort.signal.aborted || this.#views.get(id) !== view)
          throw new Error('EXTENSION_VIEW_EXPIRED')
      }
      if (method === 'resources.pickFiles' || method === 'resources.pickDirectory') {
        if (!this.#ports.selectResources)
          throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
        const selection = method === 'resources.pickDirectory' ? { filters: [], multiple: false, directory: true } : extensionResourceSelectionSchema.parse(params)
        const signal = AbortSignal.any([view.abort.signal, view.running.abort.signal, AbortSignal.timeout(120000)])
        const paths = await this.#ports.selectResources(view.running.package.manifest.name, selection, signal)
        signal.throwIfAborted()
        assertView()
        const assertSelection = () => {
          signal.throwIfAborted()
          assertView()
        }
        result = method === 'resources.pickDirectory'
          ? paths[0] ? await this.store.resources.grantDirectory(extensionId, paths[0], assertSelection) : null
          : await this.store.resources.grant(extensionId, paths, assertSelection)
      }
      else if (method === 'resources.listFiles') {
        result = await this.store.resources.list(extensionId)
      }
      else if (method === 'resources.listDirectories') {
        result = await this.store.resources.directories(extensionId)
      }
      else if (method === 'resources.readBytes') {
        const input = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).max(2 * 1024 ** 3), length: z.number().int().min(1).max(128 * 1024) }).strict().parse(params)
        result = await this.store.resources.readBytes(extensionId, input.id, input.offset, input.length, view.abort.signal)
      }
      else if (method === 'resources.readText') {
        const input = z.object({ id: z.string().uuid() }).strict().parse(params)
        result = await this.store.resources.readText(extensionId, input.id, view.abort.signal)
      }
      else if (method === 'resources.scanDirectory') {
        const signal = AbortSignal.any([view.abort.signal, view.running.abort.signal, AbortSignal.timeout(10000)])
        result = await this.store.resources.scanDirectory(extensionId, extensionDirectoryScanSchema.parse(params), () => {
          signal.throwIfAborted()
          assertView()
        })
      }
      else {
        const input = z.object({ id: z.string().uuid() }).strict().parse(params)
        if (method === 'resources.revokeDirectory') {
          await this.store.resources.revokeDirectory(extensionId, input.id, assertView)
          result = null
        }
        else if (method === 'resources.getUrl') {
          if (!(await this.store.resources.list(extensionId)).some(resource => resource.id === input.id))
            throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
          result = new URL(`/__resource/${input.id}`, view.session.url).href
        }
        else if (method === 'resources.revokeFile') {
          await this.store.resources.revoke(extensionId, input.id, assertView)
          result = null
        }
        else { throw new Error('EXTENSION_METHOD_DENIED') }
      }
    }
    else if (method === 'interaction.setRegions') {
      if (placement?.kind !== 'view' || placement.interaction !== 'regions' || !view.input.interactionId || !this.#interactions.has(view.input.interactionId))
        throw new Error('EXTENSION_METHOD_DENIED')
      const regions = workbenchHitRegionsSchema.parse(params)
      const saved = await this.#ports.workbench({ kind: 'regions', requestId: randomUUID(), viewId: id, generation, token, regions }, view.abort.signal)
      if (!saved)
        throw new Error('EXTENSION_VIEW_EXPIRED')
      result = null
    }
    else if (method === 'commands.execute') {
      const input = z.object({ command: z.string().max(180), arguments: extensionJsonSchema }).strict().parse(params)
      if (!view.running.package.manifest.contributes.commands.some(item => item.id === input.command))
        throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
      result = extensionJsonSchema.parse(await view.running.host.call('command', { ...input, resource: view.input.resource, invocation: { target: 'view', instanceId: view.input.instanceId ?? null } }))
    }
    else {
      if (method === 'resources.readText') {
        const resource = z.object({ id: z.string().uuid() }).strict().parse(params)
        if (resource.id !== view.input.resource?.id)
          throw new Error('EXTENSION_RESOURCE_DENIED')
      }
      else if (method !== 'network.get') {
        throw new Error('EXTENSION_METHOD_DENIED')
      }
      result = await this.#broker(view.running, method, params)
    }
    this.#assertCurrent(view.running)
    if (this.#views.get(id) !== view)
      throw new Error('EXTENSION_VIEW_EXPIRED')
    return result
  }

  dispose(): Promise<void> {
    if (this.#disposal)
      return this.#disposal
    this.#disposed = true
    this.#disposal = Promise.resolve().then(async () => {
      this.conditions.dispose()
      this.scheduler.dispose()
      this.catalog.dispose()
      const stopping = this.resetHosts()
      try {
        const results = await Promise.allSettled([stopping, this.#mutating, this.#compiling, ...this.#viewRequests])
        while (this.#stopping.size)
          await Promise.allSettled([...this.#stopping])
        await Promise.all([...this.#retired].map(running => running.inFlight ? new Promise<void>(resolve => running.drained.add(resolve)) : Promise.resolve()))
        while (this.#viewCleanups.size)
          await Promise.all([...this.#viewCleanups])
        await this.#refreshAgentContributions()
        await this.installations.dispose()
        const stopped = results[0]!
        if (stopped.status === 'rejected')
          throw stopped.reason
        if (this.#viewCleanupError)
          throw this.#viewCleanupError
      }
      finally { this.#changes.dispose() }
    })
    return this.#disposal
  }

  async resetHosts(): Promise<void> {
    this.#epoch++
    await Promise.all([...this.#running.keys()].map(id => this.#stop(id)))
  }

  async #activate(id: string): Promise<RunningExtension> {
    const epoch = this.#epoch
    await this.initialize()
    await this.#mutating
    if (this.#disposed || epoch !== this.#epoch)
      throw new Error('EXTENSION_HOST_STOPPED')
    for (const dependency of this.#order(id)) {
      if (this.#diagnostics.get(dependency)?.error)
        throw new Error('EXTENSION_RESTART_REQUIRED')
      let running = this.#running.get(dependency)
      if (!running) {
        const pkg = this.store.installed[dependency]!.current
        const generation = randomUUID()
        const abort = new AbortController()
        let host: ExtensionHost
        try {
          host = this.#ports.createHost(pkg, (method, params) => this.#brokerByGeneration(dependency, generation, method, params), () => this.#failed(dependency, generation))
        }
        catch (error) {
          this.#log(dependency, 'activation.failed', extensionError(error))
          this.#publish({ kind: 'host', extensionId: dependency, generation, status: 'failed', errorCode: extensionError(error) })
          throw error
        }
        running = { package: pkg, generation, abort, host, ready: Promise.resolve(), active: false, inFlight: 0, drained: new Set() }
        this.#running.set(dependency, running)
        const start = performance.now()
        const instance = running
        this.#clearError(dependency)
        running.ready = host.call('activate', { manifest: pkg.manifest, panes: pkg.manifest.apiVersion >= 3 ? this.#panes : [] }).then(() => {
          this.#assertCurrent(instance)
          instance.active = true
          this.#publish({ kind: 'host', extensionId: dependency, generation, status: 'active', durationMs: Math.round(performance.now() - start) })
          this.#publishPanes(instance)
          this.#log(dependency, 'activated', undefined, Math.round(performance.now() - start))
        }).catch(async (error: unknown) => {
          if (this.#running.get(dependency) === instance) {
            this.#log(dependency, 'activation.failed', extensionError(error))
            this.#publish({ kind: 'host', extensionId: dependency, generation, status: 'failed', errorCode: extensionError(error) })
            await this.#stop(dependency)
          }
          throw error
        })
        this.#publish({ kind: 'host', extensionId: dependency, generation, status: 'starting' })
      }
      await running.ready
      this.#assertCurrent(running)
    }
    return this.#running.get(id)!
  }

  #order(id: string): string[] {
    const order = extensionActivationOrder(this.store.installed, id)
    if (order.some(next => next !== id && this.#diagnostics.get(next)?.error))
      throw new Error('EXTENSION_DEPENDENCY_FAILED')
    if (order.some(next => !extensionCompatible(this.store.installed[next]!.current.manifest, this.store.appVersion)))
      throw new Error('EXTENSION_INCOMPATIBLE')
    return order
  }

  #assertCurrent(running: RunningExtension): void {
    const id = running.package.manifest.id
    const installed = this.store.installed[id]
    if (this.#disposed || running.abort.signal.aborted || this.#running.get(id) !== running || !installed?.enabled || installed.current.revision !== running.package.revision)
      throw new Error('EXTENSION_HOST_STOPPED')
  }

  async #brokerByGeneration(id: string, generation: string, method: string, params: unknown): Promise<JsonValue> {
    const running = this.#running.get(id)
    if (!running || running.generation !== generation)
      throw new Error('EXTENSION_HOST_STOPPED')
    return this.#broker(running, method, params)
  }

  async #broker(running: RunningExtension, method: string, params: unknown): Promise<JsonValue> {
    this.#assertCurrent(running)
    if (++running.inFlight > 64) {
      running.inFlight--
      throw new Error('EXTENSION_REQUEST_LIMIT')
    }
    const { id, dataVersion } = running.package.manifest
    try {
      let result: JsonValue
      if (method === 'configuration.get') {
        result = await this.store.configuration(id)
      }
      else if (method === 'conditions.invalidate') {
        const input = extensionConditionInvalidationSchema.parse(params)
        if (input.condition && !running.package.manifest.contributes.conditions.some(condition => condition.id === input.condition))
          throw new Error('EXTENSION_CONDITION_INVALID')
        this.conditions.invalidate({ extensionId: id, ...input })
        result = null
      }
      else if (method === 'agent.request') {
        const input = extensionAgentRequestSchema.parse(params)
        const invocation = this.#agentInvocations.get(input.invocationId)
        const permissions = running.package.manifest.permissions
        if (!invocation || invocation.running !== running || !permissions.agent || !this.#ports.agentRequest)
          throw new Error('EXTENSION_AGENT_UNAVAILABLE')
        invocation.signal.throwIfAborted()
        const capability = extensionAgentCapabilities[input.method]
        if (!capability.permitted(permissions))
          throw new Error('EXTENSION_PERMISSION_DENIED')
        capability.input.parse(input.params)
        result = await this.#ports.agentRequest(input, invocation.signal)
        invocation.signal.throwIfAborted()
      }
      else if (method === 'storage.get' || method === 'storage.read') {
        const data = await this.store.data(id)
        result = method === 'storage.read' ? data : data.value
      }
      else if (method === 'storage.set') {
        const data = z.object({ value: extensionJsonSchema, version: z.literal(dataVersion) }).strict().parse(params)
        await this.store.saveData(id, data.value, data.version, () => this.#assertCurrent(running))
        result = null
      }
      else if (method === 'notifications.show') {
        if (!running.package.manifest.permissions.notifications || !this.#ports.notify)
          throw new Error('EXTENSION_NOTIFICATIONS_DENIED')
        const notification = extensionNotificationSchema.parse(params)
        if (Date.now() - (this.#notificationTimes.get(id) ?? 0) < 1000)
          throw new Error('EXTENSION_NOTIFICATION_RATE_LIMIT')
        this.#notificationTimes.set(id, Date.now())
        result = this.#ports.notify(id, notification)
      }
      else if (method.startsWith('schedules.')) {
        if (!running.package.manifest.permissions.schedules)
          throw new Error('EXTENSION_SCHEDULES_DENIED')
        if (method === 'schedules.set') {
          const input = extensionScheduleInputSchema.parse(params)
          if (!running.package.manifest.contributes.commands.some(command => command.id === input.command))
            throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
          result = await this.scheduler.set(id, input, () => this.#assertCurrent(running))
        }
        else {
          const input = z.object({ id: extensionScheduleIdSchema }).strict().parse(params)
          if (method === 'schedules.get') {
            result = this.scheduler.get(id, input.id)
          }
          else if (method === 'schedules.remove') {
            await this.scheduler.remove(id, input.id, () => this.#assertCurrent(running))
            result = null
          }
          else {
            throw new Error('EXTENSION_METHOD_DENIED')
          }
        }
      }
      else if (method === 'resources.readText') {
        const { id: resource } = z.object({ id: z.string().uuid() }).strict().parse(params)
        result = await this.#ports.readText(await this.#resource(running, resource), running.abort.signal)
      }
      else if (method === 'interactions.start') {
        const input = z.object({ id: z.string().uuid(), title: z.string().min(1).max(100) }).strict().parse(params)
        if (running.package.manifest.apiVersion < 3 || this.#interactions.has(input.id) || [...this.#interactions.values()].filter(item => item.running === running).length >= 4)
          throw new Error('EXTENSION_INTERACTION_UNAVAILABLE')
        const abort = new AbortController()
        this.#interactions.set(input.id, { running, title: input.title, abort })
        try {
          const created = await this.#ports.workbench({ kind: 'interaction', requestId: randomUUID(), extensionId: id, generation: running.generation, interactionId: input.id, title: input.title }, AbortSignal.any([running.abort.signal, abort.signal]))
          if (created !== input.id || abort.signal.aborted)
            throw new Error('EXTENSION_INTERACTION_ENDED')
        }
        catch (error) {
          await this.endInteraction(input.id).catch(() => {})
          throw error
        }
        result = input.id
      }
      else if (method === 'interactions.end') {
        const input = z.object({ id: z.string().uuid() }).strict().parse(params)
        const interaction = this.#interactions.get(input.id)
        if (interaction && interaction.running !== running)
          throw new Error('EXTENSION_METHOD_DENIED')
        await this.endInteraction(input.id)
        result = null
      }
      else if (method === 'views.broadcast') {
        if (running.package.manifest.apiVersion < 3)
          throw new Error('EXTENSION_METHOD_DENIED')
        await this.#ports.workbench({ kind: 'message', requestId: randomUUID(), extensionId: id, generation: running.generation, message: extensionJsonSchema.parse(params) }, running.abort.signal)
        result = null
      }
      else if (method === 'placements.show' || method === 'placements.hide') {
        const input = z.object({ id: z.string().max(180), instanceId: z.string().uuid().optional(), interactionId: z.string().uuid().optional() }).strict().parse(params)
        const placement = running.package.manifest.contributes.placements.find(placement => placement.id === input.id)
        if (!placement || placement.kind === 'decoration' || (placement.kind !== 'view' && (input.instanceId || input.interactionId)) || (input.instanceId && placement.target !== 'workbench.pane'))
          throw new Error('EXTENSION_PLACEMENT_UNAVAILABLE')
        const interaction = input.interactionId ? this.#interactions.get(input.interactionId) : null
        if (!!(placement.kind === 'view' && placement.interaction) !== !!input.interactionId || (input.interactionId && interaction?.running !== running))
          throw new Error('EXTENSION_INTERACTION_ENDED')
        const requestId = randomUUID()
        result = await this.#ports.workbench({ kind: 'placement', requestId, extensionId: id, generation: running.generation, placementId: placement.id, visible: method === 'placements.show', ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.interactionId ? { interactionId: input.interactionId } : {}) }, interaction ? AbortSignal.any([running.abort.signal, interaction.abort.signal]) : running.abort.signal)
        if (placement.kind !== 'view') {
          if (result !== requestId)
            throw new Error('EXTENSION_PLACEMENT_UNAVAILABLE')
          result = placement.id
        }
        else if (method === 'placements.show' && !result) {
          throw new Error('EXTENSION_VIEW_UNAVAILABLE')
        }
      }
      else if (method === 'views.open') {
        const input = z.object({ type: z.string().max(180), resource: extensionResourceSchema.nullable(), state: extensionJsonSchema }).strict().parse(params)
        const view = running.package.manifest.contributes.views.find(view => view.id === input.type)
        if (!view)
          throw new Error('EXTENSION_VIEW_UNAVAILABLE')
        if (view.location !== 'context')
          throw new Error('EXTENSION_METHOD_DENIED')
        if (view.resource === 'selected-file' && !input.resource)
          throw new Error('EXTENSION_RESOURCE_REQUIRED')
        if (input.resource)
          await this.#resource(running, input.resource.id)
        this.#assertCurrent(running)
        result = await this.#ports.workbench({ kind: 'open', requestId: randomUUID(), extensionId: id, generation: running.generation, viewType: view.id, resource: input.resource, state: input.state, stateVersion: view.stateVersion }, running.abort.signal)
        if (!result)
          throw new Error('EXTENSION_VIEW_UNAVAILABLE')
      }
      else if (method === 'network.get') {
        const { url } = z.object({ url: z.string().url().max(8192) }).strict().parse(params)
        result = await this.#fetch(running, url)
      }
      else {
        throw new Error('EXTENSION_METHOD_DENIED')
      }
      this.#assertCurrent(running)
      return result
    }
    finally {
      running.inFlight--
      if (!running.inFlight) {
        this.#retired.delete(running)
        for (const resolve of running.drained) resolve()
        running.drained.clear()
      }
    }
  }

  async #resource(running: RunningExtension, id: string): Promise<SpaceFileTarget> {
    if (running.package.manifest.permissions.selectedResource !== 'read')
      throw new Error('EXTENSION_RESOURCE_DENIED')
    const target = await this.store.resolveGrant(running.package.manifest.id, id)
    this.#assertCurrent(running)
    return target
  }

  async #fetch(running: RunningExtension, raw: string): Promise<JsonValue> {
    let url = raw
    const signal = AbortSignal.any([running.abort.signal, AbortSignal.timeout(15000)])
    for (let redirects = 0; redirects < 4; redirects++) {
      const parsed = publicWebUrl(url)
      if (parsed.protocol !== 'https:' || !running.package.manifest.permissions.network.includes(parsed.origin))
        throw new Error('EXTENSION_NETWORK_DENIED')
      this.#assertCurrent(running)
      const response = await this.#ports.get(parsed.href, { signal })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location)
          throw new Error('EXTENSION_NETWORK_FAILED')
        url = new URL(location, parsed).href
        continue
      }
      const body = await readResponseBytes(response, 1024 * 1024)
      return { status: response.status, text: new TextDecoder().decode(body) }
    }
    throw new Error('EXTENSION_NETWORK_REDIRECT_LIMIT')
  }

  #failed(id: string, generation: string): void {
    if (this.#running.get(id)?.generation !== generation)
      return
    this.#log(id, 'host.failed', 'EXTENSION_HOST_CRASHED')
    this.#publish({ kind: 'host', extensionId: id, generation, status: 'failed', errorCode: 'EXTENSION_HOST_CRASHED' })
    void this.#stopClosure(id).catch(() => {})
  }

  #stop(id: string): Promise<void> {
    const stopping = this.#stopHost(id).finally(() => this.#stopping.delete(stopping))
    this.#stopping.add(stopping)
    return stopping
  }

  async #stopHost(id: string): Promise<void> {
    this.conditions.invalidate({ extensionId: id })
    const running = this.#running.get(id)
    if (!running)
      return
    this.#running.delete(id)
    if (running.inFlight)
      this.#retired.add(running)
    running.abort.abort()
    this.#publish({ kind: 'host', extensionId: id, generation: running.generation, status: 'stopping' })
    for (const [interactionId, interaction] of this.#interactions) {
      if (interaction.running === running)
        void this.endInteraction(interactionId).catch(() => {})
    }
    for (const view of this.#views.values()) {
      if (view.running === running) {
        this.#closeView(view)
      }
    }
    this.scheduler.refresh()
    try {
      await running.host.dispose()
      this.#publish({ kind: 'host', extensionId: id, generation: running.generation, status: 'stopped' })
    }
    catch (error) {
      this.#publish({ kind: 'host', extensionId: id, generation: running.generation, status: 'stop-failed', errorCode: extensionError(error) })
      throw error
    }
  }

  async #stopClosure(id: string): Promise<void> {
    const affected = new Set([id])
    let changed = true
    while (changed) {
      changed = false
      for (const [next, running] of this.#running) {
        if (!affected.has(next) && Object.keys(running.package.manifest.dependencies).some(dependency => affected.has(dependency))) {
          affected.add(next)
          changed = true
        }
      }
    }
    await Promise.all([...affected].reverse().map(next => this.#stop(next)))
  }

  #log(id: string, event: string, code?: string, durationMs?: number): void {
    const previous = this.#diagnostics.get(id)
    this.#diagnostics.set(id, { error: event === 'activation.failed' || event === 'host.failed' ? code ?? null : previous?.error ?? null, activationMs: durationMs ?? previous?.activationMs ?? null, logs: [...previous?.logs ?? [], { time: new Date().toISOString(), event, ...(code ? { code } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }].slice(-50) })
    this.#publish({ kind: 'diagnostic', extensionId: id, event, ...(code ? { errorCode: code } : {}), ...(durationMs === undefined ? {} : { durationMs }) })
    if (event === 'activation.failed' || event === 'host.failed')
      void this.#refreshAgentContributions().catch(() => {})
  }

  #clearError(id: string): void {
    const previous = this.#diagnostics.get(id)
    if (previous)
      this.#diagnostics.set(id, { ...previous, error: null, activationMs: null })
  }

  #mutate(operation: () => Promise<void>): Promise<void> {
    const task = this.#mutating.catch(() => {}).then(async () => {
      await this.initialize()
      if (this.#disposed)
        throw new Error('EXTENSION_HOST_STOPPED')
      try {
        await operation()
      }
      finally {
        await this.#refreshAgentContributions()
      }
    })
    this.#mutating = task.catch(() => {})
    return task
  }

  #closeView(view: RunningView): void {
    if (this.#views.get(view.input.viewId) !== view)
      return
    this.#views.delete(view.input.viewId)
    view.abort.abort()
    const cleanups: Promise<void>[] = []
    try {
      view.dispose()
    }
    catch (error) { cleanups.push(Promise.reject(error)) }
    for (const writer of view.writers.values()) cleanups.push(writer.dispose())
    view.writers.clear()
    this.#publish({ kind: 'view', extensionId: view.input.extensionId, generation: view.running.generation, viewId: view.input.viewId, status: 'closed' })
    const cleanup = Promise.allSettled(cleanups).then((results) => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        const errorCode = extensionError(failure.reason)
        this.#viewCleanupError ??= new Error(errorCode)
        this.#publish({ kind: 'view', extensionId: view.input.extensionId, generation: view.running.generation, viewId: view.input.viewId, status: 'cleanup-failed', errorCode })
      }
    }).finally(() => this.#viewCleanups.delete(cleanup))
    this.#viewCleanups.add(cleanup)
  }

  #configurationChanged(id: string, application: ExtensionConfigurationApplication, changedKeys: string[], errorCode?: string): void {
    const previous = this.#configurationApplications.get(id)
    const failure = errorCode ?? (previous?.operationId === application.operationId ? previous.errorCode : undefined)
    this.#configurationApplications.set(id, copyEventSnapshot({ ...application, ...(failure ? { errorCode: failure } : {}) }))
    this.#publish({ kind: 'configuration', extensionId: id, application, changedKeys, ...(errorCode ? { errorCode } : {}) })
  }

  #publish(fact: ExtensionServiceFact): void {
    this.#changes.fire(copyEventSnapshot({ ...fact, revision: ++this.#revision }))
  }
}
