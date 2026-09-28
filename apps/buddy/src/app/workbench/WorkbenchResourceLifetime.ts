import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { resourceKey } from '@/workbench/common/workbench'

export class WorkbenchResourceLifetime {
  readonly #subscriptions: (() => void)[]
  readonly #leases = new Map<string, number>()

  constructor(readonly controller: WorkbenchController, readonly pool: TaskWorkspacePool, readonly copies: WorkingCopyService, readonly ready: () => boolean) {
    this.#subscriptions = [
      controller.onDidChangeLayout((change) => {
        if (change.changedViewIds.length || change.removedViewIds.length || change.kind === 'restored')
          this.reconcile()
      }).dispose,
      controller.navigation.onDidChange(() => this.reconcile()).dispose,
      copies.onDidChange((change) => {
        if (!this.ready() || change.kind === 'released')
          return
        if (!this.#leases.has(change.copy.key) && !this.controller.renderedViews.some(view => resourceKey(view.resource) === change.copy.key))
          this.copies.release(change.copy.resource)
      }).dispose,
    ]
  }

  reconcile(): void {
    if (!this.ready())
      return
    const resources = this.controller.renderedViews.map(view => view.resource)
    this.pool.retain(resources)
    const retained = new Set(resources.map(resourceKey))
    for (const copy of this.copies.copies.values()) {
      if (!retained.has(copy.key) && !this.#leases.has(copy.key))
        this.copies.release(copy.resource)
    }
  }

  acquire(resource: ResourceRef): () => void {
    const key = resourceKey(resource)
    this.#leases.set(key, (this.#leases.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released)
        return
      released = true
      const remaining = (this.#leases.get(key) ?? 1) - 1
      if (remaining)
        this.#leases.set(key, remaining)
      else this.#leases.delete(key)
      this.reconcile()
    }
  }

  dispose(): void { for (const stop of this.#subscriptions) stop() }
}
