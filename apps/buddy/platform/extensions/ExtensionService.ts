import type { ExtensionMenuInvocation, ExtensionResource, ExtensionStatus, ExtensionViewInput, ExtensionViewSession, ExtensionWorkbenchEvent } from '../../shared/extensions/extensionApi'
import type { ExtensionInspection } from '../../shared/extensions/extensionAuthoring'
import type { ExtensionResourceSelection } from '../../shared/extensions/extensionResources'
import type { SpaceFileTarget } from '../../shared/spaces/spaceFileApi'
import type { WorkbenchPaneSnapshot } from '../../shared/workbench/workbenchInteraction'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionCompiler } from './compileExtensionSource'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { extensionError, extensionJsonSchema, extensionResourceSchema } from '../../shared/extensions/extensionApi'
import { EXTENSION_CATALOG_URL } from '../../shared/extensions/extensionCatalog'
import { extensionCommandNamespace } from '../../shared/extensions/extensionCommands'
import { extensionCompatible, extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { extensionDirectoryScanSchema, extensionResourceSelectionSchema } from '../../shared/extensions/extensionResources'
import { extensionNotificationSchema, extensionScheduleIdSchema, extensionScheduleInputSchema } from '../../shared/extensions/extensionSchedule'
import { workbenchHitRegionsSchema } from '../../shared/workbench/workbenchInteraction'
import { controlProposalSchema, extensionPresentationRequestSchema } from '../../shared/workbench/workbenchUi'
import { publicWebUrl, readResponseBytes } from '../network/publicWebTransport'
import { ExtensionCatalogService } from './ExtensionCatalogService'
import { unpackExtension } from './extensionFiles'
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
  changed: () => void
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
  #panes: WorkbenchPaneSnapshot[] = []
  #loading: Promise<void> | undefined
  #mutating = Promise.resolve()
  #compiling = Promise.resolve()
  #disposed = false
  #epoch = 0

  constructor(store: ExtensionPackageStore, ports: ExtensionServicePorts) {
    this.store = store
    this.#ports = ports
    this.installations = new ExtensionInstallations(store.root, ports.changed)
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

  async initialize(): Promise<void> {
    await (this.#loading ??= this.store.load().then(async () => {
      await this.installations.load()
      await this.scheduler.load()
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
      return { manifest: record.current.manifest, iconUrl: await this.store.icon(record.current), revision: record.current.revision, enabled: record.enabled, development: record.development, compatible: extensionCompatible(record.current.manifest, this.store.appVersion), pending: record.pending ? { manifest: record.pending.manifest, revision: record.pending.revision } : null, ...diagnostics, error: blocked ?? diagnostics.error, generation: running?.generation ?? null, state: !record.enabled ? 'disabled' : blocked ? 'blocked' : running ? running.active ? 'active' : 'activating' : diagnostics.error ? 'failed' : 'inactive' }
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
      await this.store.enable(id, enabled)
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
      await this.store.promote(id)
      this.#clearError(id)
      await this.scheduler.resume()
      this.#log(id, 'restarted')
    })
  }

  revokeResources(id: string): Promise<void> {
    return this.#mutate(async () => {
      await this.store.resources.revoke(id)
      await this.#stopClosure(id)
      this.#log(id, 'resources.revoked')
    })
  }

  uninstall(id: string): Promise<void> {
    return this.#mutate(async () => {
      await this.store.uninstall(id)
      await this.#stopClosure(id)
      await this.store.resources.revoke(id)
      await this.scheduler.remove(id)
      await this.store.removePackages(id)
      this.#diagnostics.delete(id)
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
    this.#panes = panes
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
    for (const [viewId, view] of this.#views) {
      if (view.input.interactionId === id) {
        view.dispose()
        this.#views.delete(viewId)
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
      resource = await this.store.grant(running.package.manifest.id, target)
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
      old?.dispose()
      const endpoint = this.#ports.createView(running.package)
      const abort = new AbortController()
      const writers = new Map<string, ExtensionResourceWriter>()
      const session = { id: input.viewId, extensionId: input.extensionId, generation: running.generation, token: endpoint.token, url: endpoint.url }
      this.#views.set(input.viewId, { input, session, running, abort, ready: false, error: null, writers, dispose: () => {
        abort.abort()
        endpoint.dispose()
        for (const writer of writers.values()) void writer.dispose().catch(() => {})
        writers.clear()
      } })
      return session
    }
    finally {
      if (this.#viewOpenings.get(input.viewId) === request)
        this.#viewOpenings.delete(input.viewId)
    }
  }

  closeView(id: string, generation: string, token: string): void {
    const view = this.#views.get(id)
    if (view?.session.generation === generation && view.session.token === token) {
      view.dispose()
      this.#views.delete(id)
    }
  }

  async viewRequest(id: string, generation: string, token: string, method: string, params: JsonValue): Promise<JsonValue> {
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
      view.ready = true
      result = null
    }
    else if (method === 'view.failed') {
      const failure = z.object({ code: z.enum(['EXTENSION_VIEW_FAILED', 'EXTENSION_VIEW_TIMEOUT']) }).safeParse(params)
      view.error = failure.success ? failure.data.code : 'EXTENSION_VIEW_FAILED'
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

  async dispose(): Promise<void> {
    this.#disposed = true
    this.scheduler.dispose()
    this.catalog.dispose()
    await this.installations.dispose()
    await this.resetHosts()
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
        if (pkg.manifest.contributes.commands.some(command => command.slash) && [...this.#running.values()].some(other => other.package.manifest.contributes.commands.some(command => command.slash) && extensionCommandNamespace(other.package.manifest.id) === extensionCommandNamespace(dependency))) {
          this.#log(dependency, 'activation.failed', 'EXTENSION_COMMAND_NAMESPACE_CONFLICT')
          throw new Error('EXTENSION_COMMAND_NAMESPACE_CONFLICT')
        }
        const generation = randomUUID()
        const abort = new AbortController()
        let host: ExtensionHost
        try {
          host = this.#ports.createHost(pkg, (method, params) => this.#brokerByGeneration(dependency, generation, method, params), () => this.#failed(dependency, generation))
        }
        catch (error) {
          this.#log(dependency, 'activation.failed', extensionError(error))
          throw error
        }
        running = { package: pkg, generation, abort, host, ready: Promise.resolve(), active: false, inFlight: 0 }
        this.#running.set(dependency, running)
        const start = performance.now()
        const instance = running
        this.#clearError(dependency)
        running.ready = host.call('activate', { manifest: pkg.manifest, panes: pkg.manifest.apiVersion >= 3 ? this.#panes : [] }).then(() => {
          this.#assertCurrent(instance)
          instance.active = true
          this.#publishPanes(instance)
          this.#log(dependency, 'activated', undefined, Math.round(performance.now() - start))
        }).catch(async (error: unknown) => {
          if (this.#running.get(dependency) === instance) {
            this.#log(dependency, 'activation.failed', extensionError(error))
            await this.#stop(dependency)
          }
          throw error
        })
        this.#ports.changed()
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
      if (method === 'storage.get' || method === 'storage.read') {
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
        if (placement?.kind !== 'view' || (input.instanceId && placement.target !== 'workbench.pane'))
          throw new Error('EXTENSION_PLACEMENT_UNAVAILABLE')
        const interaction = input.interactionId ? this.#interactions.get(input.interactionId) : null
        if (!!placement.interaction !== !!input.interactionId || (input.interactionId && interaction?.running !== running))
          throw new Error('EXTENSION_INTERACTION_ENDED')
        result = await this.#ports.workbench({ kind: 'placement', requestId: randomUUID(), extensionId: id, generation: running.generation, placementId: placement.id, visible: method === 'placements.show', ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.interactionId ? { interactionId: input.interactionId } : {}) }, interaction ? AbortSignal.any([running.abort.signal, interaction.abort.signal]) : running.abort.signal)
        if (method === 'placements.show' && !result)
          throw new Error('EXTENSION_VIEW_UNAVAILABLE')
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
    void this.#stopClosure(id)
  }

  async #stop(id: string): Promise<void> {
    const running = this.#running.get(id)
    if (!running)
      return
    this.#running.delete(id)
    running.abort.abort()
    for (const [interactionId, interaction] of this.#interactions) {
      if (interaction.running === running)
        void this.endInteraction(interactionId).catch(() => {})
    }
    for (const [viewId, view] of this.#views) {
      if (view.running === running) {
        view.dispose()
        this.#views.delete(viewId)
      }
    }
    this.#ports.changed()
    this.scheduler.refresh()
    await running.host.dispose()
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
    this.#ports.changed()
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
      await operation()
      this.#ports.changed()
    })
    this.#mutating = task.catch(() => {})
    return task
  }
}
