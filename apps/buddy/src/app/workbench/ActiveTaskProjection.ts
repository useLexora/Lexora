import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { TaskCapability } from '@/modules/tasks/contracts'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { computed, shallowRef } from 'vue'

export class ActiveTaskProjection {
  readonly #active = shallowRef<TaskCapability | null>(null)
  readonly current = computed(() => this.#active.value)
  readonly resource = shallowRef<ResourceRef | null>(null)
  readonly #subscriptions: (() => void)[]

  constructor(readonly controller: WorkbenchController, readonly pool: TaskWorkspacePool) {
    this.#subscriptions = [
      controller.onDidChangeFocus(() => this.reconcile()).dispose,
      controller.onDidChangeLayout((change) => {
        if (change.kind !== 'resized' && change.kind !== 'auxiliary')
          this.reconcile()
      }).dispose,
      pool.onDidChange(() => this.reconcile()).dispose,
    ]
    this.reconcile()
  }

  reconcile(): void {
    const pane = this.controller.pane(this.controller.layout.activePane)
    const view = pane?.view ? this.controller.layout.views[pane.view] : null
    this.resource.value = view?.resource ?? null
    const task = view ? this.pool.peek(view.resource) : undefined
    this.#active.value = task?.workspace.restoration.state.value === 'ready' ? task : null
  }

  dispose(): void { for (const stop of this.#subscriptions) stop() }
}
