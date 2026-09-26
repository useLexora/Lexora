import type { WorkbenchView } from '../common/workbench'
import type { OpenViewOptions } from './WorkbenchController'

export interface PendingWorkbenchView {
  paneId: string
  previousViewId: string
  view: WorkbenchView
  options: OpenViewOptions
  status: 'loading' | 'failed'
  ready: Promise<boolean>
}

export class WorkbenchNavigation {
  readonly entries = new Map<string, PendingWorkbenchView>()
  readonly #resolve = new Map<string, (ready: boolean) => void>()

  constructor(readonly changed: () => void) {}

  begin(paneId: string, previousViewId: string, view: WorkbenchView, options: OpenViewOptions): PendingWorkbenchView {
    this.cancel(paneId)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const entry: PendingWorkbenchView = { paneId, previousViewId, view, options, status: 'loading', ready: promise }
    this.#resolve.set(view.id, resolve)
    this.entries.set(paneId, entry)
    this.changed()
    return entry
  }

  find(viewId: string): PendingWorkbenchView | undefined {
    return [...this.entries.values()].find(entry => entry.view.id === viewId)
  }

  ready(viewId: string): void {
    const entry = this.find(viewId)
    if (entry?.status === 'loading')
      this.#settle(entry, true)
  }

  fail(viewId: string): void {
    const entry = this.find(viewId)
    if (!entry || entry.status === 'failed')
      return
    this.entries.set(entry.paneId, { ...entry, status: 'failed' })
    this.#settle(entry, false)
    this.changed()
  }

  cancel(paneId: string): void {
    if (this.remove(paneId))
      this.changed()
  }

  remove(paneId: string): boolean {
    const entry = this.entries.get(paneId)
    if (!entry)
      return false
    this.entries.delete(paneId)
    this.#settle(entry, false)
    return true
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id)
    this.changed()
  }

  #settle(entry: PendingWorkbenchView, ready: boolean): void {
    this.#resolve.get(entry.view.id)?.(ready)
    this.#resolve.delete(entry.view.id)
  }
}
