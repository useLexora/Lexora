import type { ExtensionResource, ExtensionStatus, ExtensionViewInput, ExtensionViewSession, ExtensionWorkbenchEvent } from '../../shared/extensions/extensionApi'
import type { SpaceFileTarget } from '../../shared/spaces/spaceFileApi'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionCompiler } from './compileExtensionSource'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { extensionError, extensionJsonSchema, extensionResourceSchema } from '../../shared/extensions/extensionApi'
import { EXTENSION_CATALOG_URL } from '../../shared/extensions/extensionCatalog'
import { extensionCompatible, extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { extensionNotificationSchema, extensionScheduleIdSchema, extensionScheduleInputSchema } from '../../shared/extensions/extensionSchedule'
import { publicWebUrl, readResponseBytes } from '../network/publicWebTransport'
import { ExtensionCatalogService } from './ExtensionCatalogService'
import { unpackExtension } from './extensionFiles'
import { ExtensionInstallations } from './ExtensionInstallations'
import { extensionActivationOrder } from './ExtensionPackageStore'
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
}
interface RunningExtension {
  package: ExtensionPackage
  generation: string
  abort: AbortController
  host: ExtensionHost
  ready: Promise<void>
  active: boolean
  inFlight: number
}
interface RunningView {
  input: ExtensionViewInput
  session: ExtensionViewSession
  running: RunningExtension
  dispose: () => void
}

export class ExtensionService {
  readonly store: ExtensionPackageStore
  readonly scheduler: ExtensionScheduler
  readonly installations: ExtensionInstallations
  readonly catalog: ExtensionCatalogService
  readonly #reviews = new Map<string, string>()
  readonly #ports: ExtensionServicePorts
  readonly #running = new Map<string, RunningExtension>()
  readonly #views = new Map<string, RunningView>()
  readonly #diagnostics = new Map<string, Pick<ExtensionStatus, 'error' | 'activationMs' | 'logs'>>()
  readonly #notificationTimes = new Map<string, number>()
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
      try {
        this.#order(id)
      }
      catch (error) {
        blocked = extensionError(error)
      }
      return { manifest: record.current.manifest, iconUrl: await this.store.icon(record.current), revision: record.current.revision, enabled: record.enabled, development: record.development, compatible: extensionCompatible(record.current.manifest, this.store.appVersion), pending: record.pending ? { manifest: record.pending.manifest, revision: record.pending.revision } : null, ...diagnostics, error: blocked ?? diagnostics.error, generation: running?.generation ?? null, state: !record.enabled ? 'disabled' : blocked ? 'blocked' : running ? running.active ? 'active' : 'activating' : diagnostics.error ? 'failed' : 'inactive' }
    }))
  }

  async review(path: string, development = false) {
    await this.initialize()
    const job = this.installations.begin(basename(path), 'validate')
    try {
      const review = await this.store.review(path, development)
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

  uninstall(id: string): Promise<void> {
    return this.#mutate(async () => {
      await this.store.uninstall(id)
      await this.#stopClosure(id)
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
    if (!running.package.manifest.contributes.commands.some(item => item.id === command))
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    let resource: ExtensionResource | null = null
    if (target && running.package.manifest.permissions.selectedResource === 'read') {
      await this.#ports.readText(target, running.abort.signal)
      this.#assertCurrent(running)
      resource = await this.store.grant(id, target)
    }
    this.#assertCurrent(running)
    await running.host.call('command', { command, resource, arguments: null })
    this.#assertCurrent(running)
  }

  async openView(input: ExtensionViewInput): Promise<ExtensionViewSession> {
    const running = await this.#activate(input.extensionId)
    const view = running.package.manifest.contributes.views.find(item => item.id === input.viewType)
    if (!view)
      throw new Error('EXTENSION_VIEW_UNAVAILABLE')
    if (view.resource === 'selected-file' && !input.resource)
      throw new Error('EXTENSION_RESOURCE_REQUIRED')
    if (input.resource)
      await this.#resource(running, input.resource.id)
    this.#assertCurrent(running)
    const old = this.#views.get(input.viewId)
    old?.dispose()
    const endpoint = this.#ports.createView(running.package)
    const session = { id: input.viewId, extensionId: input.extensionId, generation: running.generation, token: endpoint.token, url: endpoint.url }
    this.#views.set(input.viewId, { input, session, running, dispose: endpoint.dispose })
    return session
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
    let result: JsonValue
    if (method === 'bootstrap') {
      result = { entry: contribution.entry, location: contribution.location, resource: view.input.resource, state: view.input.state, stateVersion: view.input.stateVersion, expectedStateVersion: contribution.stateVersion }
    }
    else if (method === 'view.setState') {
      if (contribution.location !== 'context')
        throw new Error('EXTENSION_METHOD_DENIED')
      const state = extensionJsonSchema.parse(params)
      const saved = await this.#ports.workbench({ kind: 'state', requestId: randomUUID(), viewId: id, generation, state, stateVersion: contribution.stateVersion }, view.running.abort.signal)
      if (saved !== id)
        throw new Error('EXTENSION_STATE_SAVE_FAILED')
      view.input = { ...view.input, state, stateVersion: contribution.stateVersion }
      result = null
    }
    else if (method === 'view.failed') {
      this.#log(view.input.extensionId, 'view.failed', 'EXTENSION_VIEW_FAILED')
      result = null
    }
    else if (method === 'commands.execute') {
      const input = z.object({ command: z.string().max(180), arguments: extensionJsonSchema }).strict().parse(params)
      if (!view.running.package.manifest.contributes.commands.some(item => item.id === input.command))
        throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
      result = extensionJsonSchema.parse(await view.running.host.call('command', { ...input, resource: view.input.resource }))
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
        const generation = randomUUID()
        const abort = new AbortController()
        const host = this.#ports.createHost(pkg, (method, params) => this.#brokerByGeneration(dependency, generation, method, params), () => this.#failed(dependency, generation))
        running = { package: pkg, generation, abort, host, ready: Promise.resolve(), active: false, inFlight: 0 }
        this.#running.set(dependency, running)
        const start = performance.now()
        const instance = running
        this.#clearError(dependency)
        running.ready = host.call('activate', { manifest: pkg.manifest }).then(() => {
          this.#assertCurrent(instance)
          instance.active = true
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
        result = await this.#ports.workbench({ kind: 'open', requestId: randomUUID(), extensionId: id, viewType: view.id, resource: input.resource, state: input.state, stateVersion: view.stateVersion }, running.abort.signal)
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
