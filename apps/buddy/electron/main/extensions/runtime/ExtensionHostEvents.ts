import type { EventSubscription } from '../../../../shared/events/eventTypes'
import type { ExtensionHostEvents as HostEvents } from '../../../../shared/extensions/extensionEvents'
import type { ConfigurationEvents } from '../../../../shared/extensions/extensionSettings'
import type { WorkbenchPaneSnapshot } from '../../../../shared/workbench/workbenchInteraction'
import { EventBus } from '../../../../shared/events/EventBus'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'

export class ExtensionHostEvents {
  readonly #bus = new EventBus<HostEvents>(() => console.error('EXTENSION_EVENT_LISTENER_FAILED'))
  readonly events = this.#bus.subscriber
  readonly #configurationAppliers = new Set<(configuration: ConfigurationEvents['configuration:changed']['configuration']) => unknown>()
  #disposed = false
  #panes: HostEvents['workbench:panes:changed']['panes'] = Object.freeze([])

  get panes() { return this.#panes }

  updatePanes(panes: WorkbenchPaneSnapshot[]): void {
    if (this.#disposed || JSON.stringify(this.#panes) === JSON.stringify(panes))
      return
    this.#panes = copyEventSnapshot(panes)
    this.#bus.emit({ type: 'workbench:panes:changed', data: { panes: this.#panes } })
  }

  registerConfigurationApplier(listener: (configuration: ConfigurationEvents['configuration:changed']['configuration']) => unknown): EventSubscription {
    if (this.#disposed)
      return { dispose() {} }
    this.#configurationAppliers.add(listener)
    return { dispose: () => {
      this.#configurationAppliers.delete(listener)
    } }
  }

  async updateConfiguration(change: ConfigurationEvents['configuration:changed']): Promise<boolean> {
    if (this.#disposed)
      return false
    const appliers = [...this.#configurationAppliers]
    const snapshot = copyEventSnapshot(change)
    this.#bus.emit({ type: 'configuration:changed', data: snapshot })
    await Promise.all(appliers.map(async apply => apply(snapshot.configuration)))
    return !this.#disposed && appliers.length > 0
  }

  dispose(): void {
    this.#disposed = true
    this.#configurationAppliers.clear()
    this.#bus.dispose()
  }
}
