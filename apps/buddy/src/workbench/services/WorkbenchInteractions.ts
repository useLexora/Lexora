import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { EventSnapshot } from '@buddy-shared/events/eventTypes'
import type { WorkbenchInteraction } from '@buddy-shared/workbench/workbenchInteraction'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { ReadonlyMapView } from '@buddy-shared/events/ReadonlyMapView'

export interface InteractionChange {
  readonly revision: number
  readonly kind: 'added' | 'removed'
  readonly interaction: EventSnapshot<WorkbenchInteraction>
}

export class WorkbenchInteractions {
  readonly #entries = new Map<string, EventSnapshot<WorkbenchInteraction>>()
  readonly entries = new ReadonlyMapView(this.#entries)
  readonly #end = new Map<string, () => void>()
  readonly #changes: Emitter<InteractionChange>
  readonly onDidChange
  #revision = 0

  constructor(onListenerError: ListenerErrorHandler = () => console.error('INTERACTION_OBSERVER_FAILED')) {
    this.#changes = new Emitter(onListenerError)
    this.onDidChange = this.#changes.event
  }

  add(entry: WorkbenchInteraction, end: () => void): void {
    if (this.#entries.has(entry.id))
      throw new Error('INTERACTION_ALREADY_REGISTERED')
    const snapshot = copyEventSnapshot(entry)
    this.#entries.set(entry.id, snapshot)
    this.#end.set(entry.id, end)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'added', interaction: snapshot }))
  }

  remove(id: string): void {
    const interaction = this.#entries.get(id)
    if (!interaction)
      return
    this.#end.delete(id)
    this.#entries.delete(id)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'removed', interaction }))
  }

  end(id: string): void {
    const end = this.#end.get(id)
    this.remove(id)
    end?.()
  }

  dispose(): void {
    const failures: unknown[] = []
    for (const id of [...this.#entries.keys()]) {
      try {
        this.end(id)
      }
      catch (error) { failures.push(error) }
    }
    this.#changes.dispose()
    if (failures.length)
      throw new AggregateError(failures, 'Interaction cleanup failed')
  }
}
