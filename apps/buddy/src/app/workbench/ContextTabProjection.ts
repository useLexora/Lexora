import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'

export class ContextTabProjection {
  readonly #subscriptions: (() => void)[]

  constructor(readonly controller: WorkbenchController, readonly resources: () => TaskResourcePanel, readonly ready: () => boolean) {
    this.#subscriptions = [
      controller.onDidChangeLayout((change) => {
        if (change.changedViewIds.length || change.removedViewIds.length || change.kind === 'restored')
          this.reconcile()
      }).dispose,
      controller.onDidChangeFocus(() => this.#select()).dispose,
    ]
  }

  reconcile(): void {
    if (!this.ready())
      return
    const resources = this.resources()
    for (const tab of resources.allTabs.value) {
      if (tab.kind === 'view' && !this.controller.layout.views[tab.viewId])
        resources.removeView(tab.id)
    }
    for (const view of Object.values(this.controller.layout.views)) {
      if (view.location !== 'context' || typeof view.state.contextTabId === 'string')
        continue
      if (!resources.hasTab(view.id))
        resources.openView(view.id, view.title)
      else if (resources.allTabs.value.some(tab => tab.id === view.id && tab.kind === 'view' && tab.label !== view.title))
        resources.updateView(view.id, view.title)
    }
    this.#select()
  }

  dispose(): void { for (const stop of this.#subscriptions) stop() }

  #select(): void {
    if (!this.ready())
      return
    const view = this.controller.context.view
    if (view?.location === 'context')
      this.resources().selectTab(typeof view.state.contextTabId === 'string' ? view.state.contextTabId : view.id)
  }
}
