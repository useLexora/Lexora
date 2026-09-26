import type { WorkbenchInteraction } from '@buddy-shared/workbench/workbenchInteraction'

export class WorkbenchInteractions {
  readonly entries = new Map<string, WorkbenchInteraction>()
  readonly #end = new Map<string, () => void>()
  constructor(readonly changed: () => void) {}

  add(entry: WorkbenchInteraction, end: () => void): void {
    this.entries.set(entry.id, entry)
    this.#end.set(entry.id, end)
    this.changed()
  }

  remove(id: string): void {
    this.#end.delete(id)
    if (this.entries.delete(id))
      this.changed()
  }

  end(id: string): void {
    const end = this.#end.get(id)
    this.remove(id)
    end?.()
  }
}
