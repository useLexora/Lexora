import type { DesktopUpdateAction, DesktopUpdateCheckResult, DesktopUpdateState } from '../../shared/desktopUpdates'
import type { DesktopUpdateRecord, DesktopUpdateStore } from './DesktopUpdateStore'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { compareDesktopVersions } from '../../shared/desktopUpdates'
import { emptyUpdateRecord } from './DesktopUpdateStore'

export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000
export const UPDATE_REMINDER_INTERVAL = 3 * UPDATE_CHECK_INTERVAL
export const UPDATE_STARTUP_DELAY = 30_000

interface UpdateRequest {
  controller: AbortController
  manual: boolean
  promise: Promise<DesktopUpdateCheckResult>
}

export interface DesktopUpdatesOptions {
  currentVersion: string
  automatic: boolean
  enabled: boolean
  store: Pick<DesktopUpdateStore, 'read' | 'write'>
  check: (signal: AbortSignal) => Promise<DesktopUpdateCheckResult>
  canPresent: () => boolean
  isIdle: () => Promise<boolean>
  reportFailure: () => void
}

export class DesktopUpdates {
  readonly #options: DesktopUpdatesOptions
  readonly #changes: Emitter<DesktopUpdateState>
  readonly onDidChange: Emitter<DesktopUpdateState>['event']
  #record = emptyUpdateRecord()
  #revision = 0
  #enabled: boolean
  #ready = false
  #stopped = false
  #automaticAfter = 0
  #attemptAt: number | null = null
  #request: UpdateRequest | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #initialization: Promise<void> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: DesktopUpdatesOptions) {
    this.#options = options
    this.#enabled = options.enabled
    this.#changes = new Emitter(options.reportFailure)
    this.onDidChange = this.#changes.event
  }

  start(): Promise<void> {
    this.#initialization ??= this.#options.store.read().then((record) => {
      if (this.#stopped)
        return
      const result = record.result
      this.#record = {
        ...record,
        result: result
          ? {
              ...result,
              currentVersion: this.#options.currentVersion,
              status: compareDesktopVersions(result.latestVersion, this.#options.currentVersion) > 0 ? 'update_available' : 'up_to_date',
            }
          : null,
      }
      this.#publish()
      this.#schedule()
    })
    return this.#initialization
  }

  get state(): DesktopUpdateState {
    const { result, discoveredAt, seenVersion, ignoredVersion, notifiedVersion, lastNotifiedAt, snoozedReminder } = this.#record
    const candidate = result?.status === 'update_available' && !covers(ignoredVersion, result.latestVersion)
    const deferred = candidate && snoozedReminder?.version === result.latestVersion ? snoozedReminder : null
    const available = candidate && (this.#enabled || deferred !== null)
    const unseen = available && !covers(seenVersion, result.latestVersion)
    return copyEventSnapshot({
      revision: this.#revision,
      checking: this.#request !== null,
      enabled: this.#enabled,
      lastCheckedAt: this.#record.lastCheckedAt,
      lastSuccessfulCheckAt: this.#record.lastSuccessfulCheckAt,
      checkFailed: this.#record.checkFailed,
      ignoredVersion: ignoredVersion !== null && compareDesktopVersions(ignoredVersion, this.#options.currentVersion) > 0 ? ignoredVersion : null,
      result,
      notification: available
        ? {
            id: 'desktop.update',
            revision: result.latestVersion,
            kind: 'app.update-available',
            origin: 'desktop',
            attention: unseen ? 'unseen' : 'seen',
            occurredAt: new Date(discoveredAt ?? Date.now()).toISOString(),
            action: { type: 'open-app-update' },
            payload: { version: result.latestVersion },
          }
        : null,
      reminderDueAt: this.#ready && available
        ? deferred
          ? deferred.reminded ? null : deferred.until
          : unseen && !covers(notifiedVersion, result.latestVersion)
            ? lastNotifiedAt === null ? 0 : Math.min(lastNotifiedAt, Date.now()) + UPDATE_REMINDER_INTERVAL
            : null
        : null,
      reminderDeferredUntil: deferred && !deferred.reminded ? deferred.until : null,
    })
  }

  setReady(ready: boolean): void {
    if (this.#ready === ready || this.#stopped)
      return
    this.#ready = ready
    if (ready && !this.#automaticAfter)
      this.#automaticAfter = Date.now() + UPDATE_STARTUP_DELAY
    this.#publish()
    this.#schedule()
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled || this.#stopped)
      return
    this.#enabled = enabled
    if (!enabled && this.#request && !this.#request.manual)
      this.#request.controller.abort()
    this.#publish()
    this.#schedule()
  }

  check(manual = true): Promise<DesktopUpdateCheckResult> {
    if (this.#stopped)
      return Promise.reject(new Error('UPDATE_SERVICE_STOPPED'))
    if (this.#request && !this.#request.controller.signal.aborted) {
      this.#request.manual ||= manual
      return this.#request.promise
    }
    const request: UpdateRequest = {
      controller: new AbortController(),
      manual,
      promise: Promise.resolve().then(() => this.#check(request)).finally(() => {
        if (this.#request === request) {
          this.#request = null
          this.#publish()
          this.#schedule()
        }
      }),
    }
    this.#request = request
    this.#publish()
    return request.promise
  }

  acknowledge(input: DesktopUpdateAction): Promise<DesktopUpdateState> {
    return this.#enqueue(async () => {
      if (input.action === 'unignore') {
        if (this.#record.ignoredVersion === input.version) {
          await this.#commit({
            ...this.#record,
            ignoredVersion: null,
            seenVersion: this.#record.seenVersion === input.version ? null : this.#record.seenVersion,
            ...(this.#record.notifiedVersion === input.version ? { notifiedVersion: null, lastNotifiedAt: null } : {}),
          })
        }
        return this.state
      }
      const result = this.#record.result
      if (result?.latestVersion !== input.version || result.status !== 'update_available')
        return this.state
      if (input.action === 'snooze') {
        const until = new Date()
        if (input.delay === 'tomorrow')
          until.setDate(until.getDate() + 1)
        else
          until.setTime(until.getTime() + 30 * 60_000)
        await this.#commit({ ...this.#record, seenVersion: input.version, snoozedReminder: { version: input.version, until: until.getTime(), reminded: false } })
        return this.state
      }
      if (input.action === 'cancel-snooze') {
        if (this.#record.snoozedReminder?.version === input.version)
          await this.#commit({ ...this.#record, snoozedReminder: null })
        return this.state
      }
      if (input.action === 'reminded') {
        const deferred = this.#record.snoozedReminder?.version === input.version ? this.#record.snoozedReminder : null
        if (deferred && (deferred.reminded || deferred.until > Date.now()))
          return this.state
        if (!covers(this.#record.notifiedVersion, input.version) || deferred?.version === input.version)
          await this.#commit({ ...this.#record, seenVersion: this.#record.seenVersion === input.version ? null : this.#record.seenVersion, snoozedReminder: deferred ? { ...deferred, reminded: true } : null, notifiedVersion: input.version, lastNotifiedAt: Date.now() })
        return this.state
      }
      await this.#commit({
        ...this.#record,
        seenVersion: input.version,
        ...(this.#record.snoozedReminder?.reminded ? { snoozedReminder: null } : {}),
        ...(input.action === 'ignore' ? { ignoredVersion: input.version, snoozedReminder: null } : {}),
      })
      return this.state
    })
  }

  takeReminder(): Promise<DesktopUpdateCheckResult | null> {
    return this.#enqueue(async () => {
      if (!this.#canRemind() || !await this.#options.isIdle() || !this.#canRemind())
        return null
      return this.#record.result
    })
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#request?.controller.abort()
    await this.#request?.promise.catch(() => {})
    await this.#initialization?.catch(() => {})
    await this.#tail.catch(() => {})
    this.#changes.dispose()
  }

  async #check(request: UpdateRequest): Promise<DesktopUpdateCheckResult> {
    const signal = request.controller.signal
    this.#attemptAt = Date.now()
    await this.start()
    signal.throwIfAborted()
    await this.#enqueue(async () => {
      signal.throwIfAborted()
      await this.#commit({ ...this.#record, lastCheckedAt: this.#attemptAt })
    })
    signal.throwIfAborted()
    let result: DesktopUpdateCheckResult
    try {
      result = await this.#options.check(signal)
    }
    catch (error) {
      if (!signal.aborted) {
        await this.#enqueue(async () => {
          if (!signal.aborted && this.#request === request)
            await this.#commit({ ...this.#record, checkFailed: true })
        })
      }
      throw error
    }
    return this.#enqueue(async () => {
      signal.throwIfAborted()
      const previous = this.#record.result
      await this.#commit({
        ...this.#record,
        result,
        lastSuccessfulCheckAt: Date.now(),
        checkFailed: false,
        snoozedReminder: this.#record.snoozedReminder?.version === result.latestVersion ? this.#record.snoozedReminder : null,
        discoveredAt: previous?.latestVersion === result.latestVersion ? this.#record.discoveredAt : Date.now(),
        ...(request.manual ? { seenVersion: result.latestVersion } : {}),
      })
      if (request.manual && !covers(this.#record.seenVersion, result.latestVersion))
        await this.#commit({ ...this.#record, seenVersion: result.latestVersion })
      return result
    })
  }

  #canRemind(): boolean {
    const due = this.state.reminderDueAt
    return !this.#stopped && this.#ready && due !== null && due <= Date.now() && this.#options.canPresent()
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(async () => {
      await this.start()
      if (this.#stopped)
        throw new Error('UPDATE_SERVICE_STOPPED')
      return operation()
    })
    this.#tail = pending.catch(() => {})
    return pending
  }

  async #commit(record: DesktopUpdateRecord): Promise<void> {
    await this.#options.store.write(record)
    this.#record = record
    this.#publish()
  }

  #publish(): void {
    this.#revision++
    if (!this.#stopped)
      this.#changes.fire(this.state)
  }

  #schedule(): void {
    clearTimeout(this.#timer)
    if (this.#stopped || !this.#enabled || !this.#ready || !this.#options.automatic || this.#request)
      return
    const checked = this.#attemptAt
    const due = Math.max(this.#automaticAfter, checked === null ? 0 : Math.min(checked, Date.now()) + UPDATE_CHECK_INTERVAL)
    this.#timer = setTimeout(() => {
      void this.check(false).catch(() => {
        if (this.#enabled && !this.#stopped)
          this.#options.reportFailure()
      })
    }, Math.max(0, due - Date.now()))
    this.#timer.unref?.()
  }
}

function covers(saved: string | null, candidate: string): boolean {
  return saved !== null && compareDesktopVersions(saved, candidate) >= 0
}
