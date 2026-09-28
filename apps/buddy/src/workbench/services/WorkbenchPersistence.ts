import type { Event, ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { WorkbenchState, WorkbenchStateApi } from '@buddy-shared/workbench/workbenchState'
import type { WorkbenchLayout } from '../common/workbench'
import type { WorkbenchController } from './WorkbenchController'
import type { WorkingCopyService } from './WorkingCopyService'
import { Emitter, filterEvent } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { resourceKey } from '../common/workbench'
import { restoreWorkbenchLayout } from './WorkbenchController'
import { WorkingCopyBackup } from './WorkingCopyBackup'

export interface WorkbenchPersistenceRevision {
  readonly revision: number
  readonly layoutRevision: number
  readonly backupRevision: number
  readonly configurationRevision: number
}
export type WorkbenchPersistenceResult
  = | (WorkbenchPersistenceRevision & { readonly status: 'saved' })
    | (WorkbenchPersistenceRevision & { readonly status: 'failed', readonly error: 'WORKBENCH_STATE_WRITE_FAILED' })

export class WorkbenchPersistence {
  readonly backups: WorkingCopyBackup
  readonly #api: WorkbenchStateApi
  readonly #controller: WorkbenchController
  readonly #copies: WorkingCopyService
  readonly #report: (error: unknown | null) => void
  readonly #events: Emitter<WorkbenchPersistenceResult>
  #timer: ReturnType<typeof setTimeout> | undefined
  #deadline: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<void> = Promise.resolve()
  #revision = 0
  #saved: WorkbenchPersistenceRevision = { revision: 0, layoutRevision: -1, backupRevision: 0, configurationRevision: -1 }
  #ready = false
  #restored = false
  #restoring: Promise<boolean> | undefined
  #disposed = false
  #disposing: Promise<void> | undefined
  #stop: Array<() => void> = []

  constructor(api: WorkbenchStateApi, controller: WorkbenchController, copies: WorkingCopyService, report: (error: unknown | null) => void, onListenerError: ListenerErrorHandler = () => console.error('WORKBENCH_PERSISTENCE_OBSERVER_FAILED')) {
    this.#api = api
    this.#controller = controller
    this.#copies = copies
    this.#report = report
    this.#events = new Emitter(onListenerError)
    this.backups = new WorkingCopyBackup(copies, backupRevision => this.flushThrough({ backupRevision }), onListenerError)
  }

  readonly onDidWrite: Event<WorkbenchPersistenceResult> = (listener, options) => this.#events.event(listener, options)
  readonly onDidPersist = filterEvent(this.onDidWrite, event => event.status === 'saved')
  readonly onDidFailWrite = filterEvent(this.onDidWrite, event => event.status === 'failed')
  get revision(): number { return this.#revision }
  get savedRevision(): WorkbenchPersistenceRevision { return copyEventSnapshot(this.#saved) }
  get ready(): boolean { return this.#ready && !this.#disposed }

  restore(prepareLayout?: (layout: WorkbenchLayout) => Promise<void>): Promise<boolean> {
    if (this.#disposed)
      return Promise.reject(new Error('WORKBENCH_PERSISTENCE_DISPOSED'))
    if (this.#ready)
      return Promise.resolve(this.#restored)
    this.#restoring ??= this.#restore(prepareLayout).catch((error: unknown) => {
      this.#restoring = undefined
      throw error
    })
    return this.#restoring
  }

  checkpoint(): Promise<void> {
    this.#revision += 1
    return this.flush(true)
  }

  capture(): WorkbenchPersistenceRevision {
    return copyEventSnapshot({ revision: this.#revision, layoutRevision: this.#controller.layoutRevision, backupRevision: this.backups.revision, configurationRevision: this.#controller.configuration.revision })
  }

  flush(resetRecovery = false): Promise<void> {
    return this.flushThrough(this.capture(), resetRecovery)
  }

  flushThrough(target: Partial<WorkbenchPersistenceRevision>, resetRecovery = false): Promise<void> {
    if (this.#disposed || !this.#ready)
      return Promise.reject(new Error(this.#disposed ? 'WORKBENCH_PERSISTENCE_DISPOSED' : 'WORKBENCH_PERSISTENCE_NOT_READY'))
    const current = this.capture()
    const wanted = { ...current, ...target }
    for (const key of Object.keys(wanted) as Array<keyof WorkbenchPersistenceRevision>) {
      if (!Number.isSafeInteger(wanted[key]) || wanted[key] < 0 || wanted[key] > current[key])
        return Promise.reject(new Error('WORKBENCH_PERSISTENCE_INVALID_REVISION'))
    }
    this.#clearTimers()
    this.#tail = this.#tail.catch(() => {}).then(async () => {
      if (!resetRecovery && this.#covers(wanted))
        return
      const receipt = this.capture()
      const snapshot: WorkbenchState = JSON.parse(JSON.stringify({
        version: 1,
        layout: { ...this.#controller.layout, views: Object.fromEntries(Object.entries(this.#controller.layout.views).filter(([, view]) => !view.interactionId)) },
        backups: this.backups.snapshot().backups,
        configuration: this.#controller.configuration.snapshot(),
      }))
      try {
        await this.#api.write(snapshot, { resetRecovery })
      }
      catch (error: unknown) {
        this.backups.markWriteFailed()
        this.#events.fire(copyEventSnapshot({ ...receipt, status: 'failed', error: 'WORKBENCH_STATE_WRITE_FAILED' }))
        this.#reportResult(error)
        throw error
      }
      this.#saved = receipt
      this.backups.acceptPersisted(receipt.backupRevision)
      this.#events.fire(copyEventSnapshot({ ...receipt, status: 'saved' }))
      this.#reportResult(null)
    })
    return this.#tail
  }

  dispose(): Promise<void> {
    if (this.#disposing)
      return this.#disposing
    this.#disposed = true
    this.#clearTimers()
    this.#stop.forEach(stop => stop())
    this.#stop = []
    this.#disposing = this.#tail.catch(() => {}).then(() => {
      this.backups.dispose()
      this.#events.dispose()
    })
    return this.#disposing
  }

  async #restore(prepareLayout?: (layout: WorkbenchLayout) => Promise<void>): Promise<boolean> {
    const state = await this.#api.read()
    if (this.#disposed)
      throw new Error('WORKBENCH_PERSISTENCE_DISPOSED')
    if (state) {
      const layout = restoreWorkbenchLayout(state.layout)
      await prepareLayout?.(layout)
      if (this.#disposed)
        throw new Error('WORKBENCH_PERSISTENCE_DISPOSED')
      this.#controller.configuration.restore(state.configuration)
      this.#copies.restore(state.backups)
      this.#controller.restoreLayout(layout)
      for (const copy of this.#copies.copies.values()) {
        if (!Object.values(this.#controller.layout.views).some(view => resourceKey(view.resource) === copy.key)) {
          try {
            await this.#controller.open(copy.resource, copy.resource.id.split('/').at(-1) ?? copy.resource.id)
          }
          catch {
            // Unavailable factories must not remove an independent working-copy backup.
          }
        }
      }
    }
    if (this.#disposed)
      throw new Error('WORKBENCH_PERSISTENCE_DISPOSED')
    this.#restored = state !== null
    this.#ready = true
    this.#stop = [
      this.#controller.onDidChangeLayout(() => this.#schedule()).dispose,
      this.backups.onDidChange(() => this.#schedule()).dispose,
      this.#controller.configuration.onDidChangeRaw(() => this.#schedule()).dispose,
    ]
    this.#schedule()
    return this.#restored
  }

  #covers(target: WorkbenchPersistenceRevision): boolean {
    return Object.entries(target).every(([key, revision]) => this.#saved[key as keyof WorkbenchPersistenceRevision] >= revision)
  }

  #clearTimers(): void {
    clearTimeout(this.#timer)
    clearTimeout(this.#deadline)
    this.#timer = undefined
    this.#deadline = undefined
  }

  #schedule(): void {
    if (this.#disposed)
      return
    this.#revision += 1
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush().catch(() => {}), 350)
    this.#deadline ??= setTimeout(() => void this.flush().catch(() => {}), 2000)
  }

  #reportResult(error: unknown | null): void {
    try {
      this.#report(error)
    }
    catch {
      console.error('WORKBENCH_PERSISTENCE_REPORT_FAILED')
    }
  }
}
