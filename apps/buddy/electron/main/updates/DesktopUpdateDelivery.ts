import type { DesktopUpdateDeliveryState } from '../../shared/desktopUpdates'
import type { DesktopUpdateCache } from './DesktopUpdateCache'
import type { DesktopUpdatePackage } from './DesktopUpdatePackage'
import type { DesktopUpdatePlan } from './DesktopUpdatePolicy'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { readDesktopUpdateFailure } from './DesktopUpdateFailure'
import { downloadDesktopUpdatePackage, verifyDesktopUpdatePackage } from './DesktopUpdatePackage'

interface DeliveryOptions {
  directory: string | null
  cache?: DesktopUpdateCache
  get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  requestInstall: (prepare: () => Promise<(() => void) | void>) => Promise<boolean>
  launchInstaller: (path: string, update: DesktopUpdatePackage) => Promise<(() => void) | void>
  openPackage: (path: string) => Promise<void>
  reportFailure: (error: unknown) => void
}

export class DesktopUpdateDelivery {
  readonly #options: DeliveryOptions
  readonly #changes: Emitter<DesktopUpdateDeliveryState>
  readonly onDidChange: Emitter<DesktopUpdateDeliveryState>['event']
  #state: DesktopUpdateDeliveryState
  #update: DesktopUpdatePackage | null = null
  #download: { controller: AbortController, promise: Promise<void>, automatic: boolean } | null = null
  #ready: { path: string, update: DesktopUpdatePackage } | null = null
  #cancelledVersion: string | null = null
  #automaticAllowed = false
  #plan: DesktopUpdatePlan
  #stopped = false
  #installation: Promise<void> | null = null
  #restoration: Promise<void> | null = null
  #clearing: Promise<void> | null = null
  #generation = 0
  #pendingPlan: DesktopUpdatePlan | null = null

  constructor(options: DeliveryOptions) {
    this.#options = options
    this.#plan = { mode: 'release', reason: options.directory ? 'metadata-required' : 'distribution-unavailable', update: null, fallback: null }
    this.#state = { mode: this.#plan.mode, reason: this.#plan.reason, status: 'idle', version: null, progressPercent: 0 }
    this.#changes = new Emitter(options.reportFailure)
    this.onDidChange = this.#changes.event
  }

  get state(): DesktopUpdateDeliveryState { return copyEventSnapshot(this.#state) }

  async restore(version: string | null): Promise<void> {
    try {
      const plan = await this.#options.cache?.readPlan(version)
      if (plan && !this.#update && !this.#stopped) {
        this.discover(plan)
        await this.#restoration
      }
      await this.#options.cache?.cleanup(this.#plan, this.#download ? this.#update?.name : undefined)
    }
    catch (error) {
      this.#options.reportFailure(error)
    }
  }

  cacheSummary() {
    return this.#options.cache?.summary() ?? Promise.resolve({ bytes: 0, files: 0 })
  }

  clearCache(): Promise<void> {
    if (this.#download || this.#installation || this.#restoration || this.#clearing || this.#stopped || !this.#options.cache)
      return Promise.reject(new Error('UPDATE_CACHE_BUSY'))
    this.cancel()
    this.#clearing = this.#options.cache.clear().then(() => {
      this.#ready = null
      this.#setState({ status: this.#update ? 'available' : 'idle', version: this.#update?.version ?? null, progressPercent: 0 })
    }).finally(() => {
      this.#clearing = null
      this.#applyPendingPlan()
    })
    return this.#clearing
  }

  discover(plan: DesktopUpdatePlan): void {
    const update = plan.update
    if (this.#stopped || !this.#options.directory)
      return
    if (this.#installation || this.#clearing) {
      this.#pendingPlan = plan
      return
    }
    if (this.#update?.url === update?.url && this.#update?.sha256 === update?.sha256 && this.#update?.size === update?.size && this.#plan.mode === plan.mode && this.#plan.reason === plan.reason) {
      this.#plan = plan
      return
    }
    this.#download?.controller.abort()
    this.#generation++
    this.#plan = plan
    this.#update = update
    this.#cancelledVersion = null
    this.#ready = null
    if (update && this.#options.cache) {
      const generation = this.#generation
      this.#setState({ status: 'verifying', version: update.version, progressPercent: 0 })
      const restoration = this.#options.cache.verifiedPath(update).then(async (path) => {
        if (generation !== this.#generation || this.#stopped)
          return
        if (path) {
          await this.#options.cache?.remember(plan)
          if (generation !== this.#generation || this.#stopped)
            return
          this.#ready = { path, update }
        }
        this.#setState({ status: path ? 'ready' : 'available', version: update.version, progressPercent: path ? 100 : 0 })
      }).catch((error: unknown) => {
        if (generation === this.#generation && !this.#stopped)
          this.#setState({ status: 'error', version: update.version, progressPercent: 0, failure: readDesktopUpdateFailure(error).kind })
        this.#options.reportFailure(error)
      }).finally(() => {
        if (this.#restoration === restoration)
          this.#restoration = null
      })
      this.#restoration = restoration
    }
    else {
      this.#setState({ status: update ? 'available' : 'idle', version: update?.version ?? null, progressPercent: 0 })
    }
  }

  reconcile(eligible: boolean, automatic: boolean): void {
    this.#automaticAllowed = eligible && automatic
    if (this.#stopped || !this.#options.directory)
      return
    if (!eligible || !automatic) {
      if (this.#download?.automatic)
        this.#download.controller.abort()
      return
    }
    if (this.#state.status === 'available' && this.#update?.version !== this.#cancelledVersion)
      void this.download(true).catch(this.#options.reportFailure)
  }

  async download(automatic = false): Promise<void> {
    const generation = this.#generation
    const version = this.#update?.version
    if (!automatic)
      this.#cancelledVersion = null
    if (this.#restoration)
      await this.#restoration
    if (this.#download?.controller.signal.aborted)
      await this.#download.promise.catch(() => {})
    if (generation !== this.#generation || version === this.#cancelledVersion || (automatic && !this.#automaticAllowed))
      return
    if (this.#clearing)
      throw new Error('UPDATE_CACHE_BUSY')
    if (this.#stopped || !this.#update || !this.#options.directory)
      throw new Error('UPDATE_DOWNLOAD_UNAVAILABLE')
    if (this.#download) {
      if (!automatic)
        this.#download.automatic = false
      return this.#download.promise
    }
    if (this.#ready)
      return
    const update = this.#update
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)])
    const promise = downloadDesktopUpdatePackage({
      directory: this.#options.directory,
      update,
      get: this.#options.get,
      signal,
      progress: (progressPercent, downloadedBytes) => {
        if (this.#update === update && !this.#stopped && !controller.signal.aborted)
          this.#setState({ status: 'downloading', version: update.version, progressPercent, downloadedBytes })
      },
    }).then(async (path) => {
      signal.throwIfAborted()
      if (this.#update !== update || this.#stopped)
        return
      await this.#options.cache?.remember(this.#plan)
      signal.throwIfAborted()
      if (this.#update !== update || this.#stopped)
        return
      this.#ready = { path, update }
      this.#setState({ status: 'ready', version: update.version, progressPercent: 100 })
      await this.#options.cache?.cleanup(this.#plan).catch(this.#options.reportFailure)
    }).catch((error: unknown) => {
      if (this.#update === update && !this.#stopped)
        this.#setState({ status: controller.signal.aborted ? 'available' : 'error', version: update.version, progressPercent: 0, ...(controller.signal.aborted ? {} : { failure: readDesktopUpdateFailure(error).kind }) })
      if (!controller.signal.aborted)
        throw error
    }).finally(() => {
      if (this.#download?.controller === controller)
        this.#download = null
    })
    this.#download = { controller, promise, automatic }
    this.#setState({ status: 'downloading', version: update.version, progressPercent: 0 })
    return promise
  }

  cancel(): void {
    this.#cancelledVersion = this.#update?.version ?? null
    this.#download?.controller.abort()
  }

  resumeAutomaticDownload(version: string): void {
    if (this.#cancelledVersion === version)
      this.#cancelledVersion = null
  }

  install(): Promise<void> {
    if (this.#installation)
      return this.#installation
    const ready = this.#ready
    if (this.#stopped || this.#clearing || !ready || this.#plan.mode !== 'restart')
      return Promise.reject(new Error('UPDATE_INSTALL_UNAVAILABLE'))
    this.#installation = (async () => {
      if (!await this.#verifyReady(ready)) {
        this.#ready = null
        this.#setState({ status: 'error', version: ready.update.version, progressPercent: 0, failure: 'verification' })
        throw new Error('UPDATE_PACKAGE_INVALID')
      }
      this.#setState({ status: 'installing', version: ready.update.version, progressPercent: 100 })
      try {
        const committed = await this.#options.requestInstall(async () => {
          if (!await this.#verifyReady(ready)) {
            this.#ready = null
            throw new Error('UPDATE_PACKAGE_INVALID')
          }
          return this.#options.launchInstaller(ready.path, ready.update)
        })
        if (!committed)
          this.#setState({ status: 'ready', version: ready.update.version, progressPercent: 100 })
      }
      catch (error) {
        if (this.#plan.reason === 'system-package' && error instanceof Error && error.message === 'UPDATE_INSTALL_CANCELLED') {
          this.#setState({ status: 'ready', version: ready.update.version, progressPercent: 100 })
          return
        }
        if (this.#ready && this.#plan.reason === 'system-package') {
          this.#plan = { ...this.#plan, mode: 'manual', reason: 'installer-unavailable' }
          this.#setState({ status: 'ready', version: ready.update.version, progressPercent: 100 })
          this.#options.reportFailure(error)
          return
        }
        if (this.#plan.fallback) {
          const fallback = this.#plan.fallback
          if (!this.#pendingPlan || this.#pendingPlan.update?.version === ready.update.version)
            this.#pendingPlan = { mode: 'open-package', reason: 'installer-unavailable', update: fallback, fallback: null }
          this.#options.reportFailure(error)
          return
        }
        this.#setState({ status: this.#ready ? 'ready' : 'error', version: ready.update.version, progressPercent: this.#ready ? 100 : 0, ...(this.#ready ? {} : { failure: readDesktopUpdateFailure(error).kind }) })
        throw error
      }
    })().finally(() => {
      this.#installation = null
      this.#applyPendingPlan()
    })
    return this.#installation
  }

  async openPackage(): Promise<void> {
    const ready = this.#ready
    if (this.#stopped || this.#clearing || !ready || this.#plan.mode !== 'open-package')
      throw new Error('UPDATE_INSTALL_UNAVAILABLE')
    if (!await this.#verifyReady(ready)) {
      this.#ready = null
      this.#setState({ status: 'error', version: ready.update.version, progressPercent: 0, failure: 'verification' })
      throw new Error('UPDATE_PACKAGE_INVALID')
    }
    await this.#options.openPackage(ready.path)
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    this.cancel()
    await this.#download?.promise.catch(() => {})
    await this.#restoration?.catch(() => {})
    await this.#clearing?.catch(() => {})
    this.#changes.dispose()
  }

  #setState(state: Omit<DesktopUpdateDeliveryState, 'mode' | 'reason'>): void {
    this.#state = { ...state, totalBytes: this.#update?.size ?? null, downloadedBytes: ['ready', 'installing'].includes(state.status) ? this.#update?.size ?? 0 : state.downloadedBytes ?? 0, mode: this.#plan.mode, reason: this.#plan.reason }
    this.#changes.fire(this.state)
  }

  async #verifyReady(ready: { path: string, update: DesktopUpdatePackage }): Promise<boolean> {
    return this.#options.cache ? await this.#options.cache.verifiedPath(ready.update) === ready.path : verifyDesktopUpdatePackage(ready.path, ready.update)
  }

  #applyPendingPlan(): void {
    const plan = this.#pendingPlan
    this.#pendingPlan = null
    if (plan)
      this.discover(plan)
  }
}
