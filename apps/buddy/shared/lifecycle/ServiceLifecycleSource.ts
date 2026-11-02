import type { ListenerErrorHandler } from '../events/Emitter'
import type { LifecycleComponent, LifecycleProgress, ServiceLifecycleChange, ServiceLifecycleReader, ServiceLifecycleSnapshot } from './serviceLifecycle'
import { Emitter } from '../events/Emitter'
import { copyEventSnapshot } from '../events/eventSnapshot'
import { lifecycleProgressSchema } from './serviceLifecycle'

export class ServiceLifecycleSource {
  readonly #changes: Emitter<ServiceLifecycleChange>
  readonly #components = new Map<string, LifecycleComponent>()
  readonly reader: ServiceLifecycleReader
  #snapshot: ServiceLifecycleSnapshot = copyEventSnapshot({ sourceId: crypto.randomUUID(), revision: 0, stopping: false, components: [] })

  constructor(onListenerError: ListenerErrorHandler = () => {}) {
    this.#changes = new Emitter(onListenerError)
    const snapshot = () => this.#snapshot
    this.reader = Object.freeze({
      get snapshot() { return snapshot() },
      onDidChange: this.#changes.event,
    })
  }

  update(component: LifecycleComponent): void {
    this.#components.set(component.component, copyEventSnapshot(component))
    this.#publish(component)
  }

  updateProgress(id: string, operationId: string, progress: LifecycleProgress): void {
    const component = this.#components.get(id)
    if (!component || component.operationId !== operationId || component.status !== 'starting' || this.#snapshot.stopping)
      return
    const next = lifecycleProgressSchema.parse(progress)
    if (component.progress?.completed === next.completed && component.progress.total === next.total)
      return
    this.#components.set(id, copyEventSnapshot({ ...component, progress: next }))
    this.#publish()
  }

  stopping(): void {
    if (this.#snapshot.stopping)
      return
    this.#snapshot = { ...this.#snapshot, stopping: true }
    this.#publish()
  }

  #publish(component?: LifecycleComponent): void {
    this.#snapshot = copyEventSnapshot({ ...this.#snapshot, revision: this.#snapshot.revision + 1, components: [...this.#components.values()] })
    this.#changes.fire(copyEventSnapshot({ snapshot: this.#snapshot, ...(component ? { component } : {}) }))
  }
}
