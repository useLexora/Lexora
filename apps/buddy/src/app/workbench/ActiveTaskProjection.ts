import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { TaskCapability } from '@/modules/tasks/contracts'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { computed, shallowRef } from 'vue'

export class ActiveTaskProjection {
  readonly #taskId = shallowRef<string | null>(null)
  readonly taskId = computed(() => this.#taskId.value)
  readonly #active = shallowRef<TaskCapability | null>(null)
  readonly current = computed(() => this.#active.value?.workspace.restoration.state.value === 'ready' ? this.#active.value : null)
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
    this.#taskId.value = view?.resource.scheme === 'task' ? view.resource.id : null
    const task = view ? this.pool.peek(view.resource) : undefined
    this.#active.value = task ?? null
  }

  dispose(): void { for (const stop of this.#subscriptions) stop() }
}
