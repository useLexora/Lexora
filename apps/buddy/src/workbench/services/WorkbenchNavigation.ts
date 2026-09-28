import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { WorkbenchView } from '../common/workbench'
import type { OpenViewOptions } from './WorkbenchController'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { ReadonlyMapView } from '@buddy-shared/events/ReadonlyMapView'

export interface PendingWorkbenchView {
  readonly paneId: string
  readonly previousViewId: string
  readonly view: WorkbenchView
  readonly options: Readonly<OpenViewOptions>
  readonly status: 'loading' | 'failed'
  readonly ready: Promise<boolean>
}
export interface NavigationChange {
  readonly revision: number
  readonly paneId: string
  readonly viewId: string
  readonly kind: 'started' | 'ready' | 'failed' | 'cancelled' | 'removed' | 'updated'
}

export class WorkbenchNavigation {
  readonly #entries = new Map<string, PendingWorkbenchView>()
  readonly entries = new ReadonlyMapView(this.#entries)
  readonly #resolve = new Map<string, (ready: boolean) => void>()
  readonly #changes: Emitter<NavigationChange>
  readonly onDidChange
  #revision = 0

  constructor(onListenerError: ListenerErrorHandler = () => console.error('NAVIGATION_OBSERVER_FAILED')) {
    this.#changes = new Emitter(onListenerError)
    this.onDidChange = this.#changes.event
  }

  begin(paneId: string, previousViewId: string, view: WorkbenchView, options: OpenViewOptions): PendingWorkbenchView {
    this.cancel(paneId)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const entry: PendingWorkbenchView = Object.freeze({ paneId, previousViewId, view: copyEventSnapshot(view), options: Object.freeze({ ...options, ...(options.state ? { state: copyEventSnapshot(options.state) } : {}) }), status: 'loading', ready: promise })
    this.#resolve.set(view.id, resolve)
    this.#entries.set(paneId, entry)
    this.#publish(entry, 'started')
    return entry
  }

  find(viewId: string): PendingWorkbenchView | undefined {
    return [...this.#entries.values()].find(entry => entry.view.id === viewId)
  }

  update(viewId: string, change: Partial<Pick<WorkbenchView, 'title' | 'state' | 'resource' | 'presentation'>>): void {
    const entry = this.find(viewId)
    if (!entry)
      return
    const next = Object.freeze({ ...entry, view: copyEventSnapshot({ ...entry.view, ...change }) })
    this.#entries.set(entry.paneId, next)
    this.#publish(next, 'updated')
  }

  ready(viewId: string): void {
    const entry = this.find(viewId)
    if (entry?.status === 'loading' && this.#resolve.has(viewId)) {
      this.#settle(entry, true)
      this.#publish(entry, 'ready')
    }
  }

  fail(viewId: string): void {
    const entry = this.find(viewId)
    if (!entry || entry.status === 'failed')
      return
    const next = Object.freeze({ ...entry, status: 'failed' as const })
    this.#entries.set(entry.paneId, next)
    this.#settle(entry, false)
    this.#publish(next, 'failed')
  }

  cancel(paneId: string): void { this.#remove(paneId, 'cancelled') }
  remove(paneId: string): boolean { return this.#remove(paneId, 'removed') }
  clear(): void { for (const id of [...this.#entries.keys()]) this.cancel(id) }
  dispose(): void {
    this.clear()

    this.#changes.dispose()
  }

  #remove(paneId: string, kind: 'removed' | 'cancelled'): boolean {
    const entry = this.#entries.get(paneId)
    if (!entry)
      return false
    this.#entries.delete(paneId)
    this.#settle(entry, false)
    this.#publish(entry, kind)
    return true
  }

  #settle(entry: PendingWorkbenchView, ready: boolean): void {
    const resolve = this.#resolve.get(entry.view.id)
    this.#resolve.delete(entry.view.id)
    resolve?.(ready)
  }

  #publish(entry: PendingWorkbenchView, kind: NavigationChange['kind']): void {
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, paneId: entry.paneId, viewId: entry.view.id, kind }))
  }
}
