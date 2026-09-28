import type { WorkbenchPaneSnapshot } from '@buddy-shared/workbench/workbenchInteraction'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'

export interface WorkbenchPaneChange {
  readonly revision: number
  readonly kind: 'registered' | 'removed' | 'measured'
  readonly snapshot: readonly WorkbenchPaneSnapshot[]
}

export class WorkbenchPaneRegistry {
  readonly #elements = new Map<string, HTMLElement>()
  readonly #changes = new Emitter<WorkbenchPaneChange>(() => console.error('WORKBENCH_PANE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  #root: HTMLElement | null = null
  #snapshot: readonly WorkbenchPaneSnapshot[] = Object.freeze([])
  #resize: ResizeObserver | null = null
  #mutation: MutationObserver | null = null
  #frame = 0
  constructor(readonly active: () => string) {}

  get snapshot(): readonly WorkbenchPaneSnapshot[] { return this.#snapshot }
  get revision(): number { return this.#revision }
  subscribe(listener: () => void): () => void {
    return this.onDidChange(listener).dispose
  }

  register(id: string | null, element: HTMLElement): () => void {
    if (this.#disposed)
      throw new Error('WORKBENCH_PANES_DISPOSED')
    if (id === null)
      this.#root = element
    else
      this.#elements.set(id, element)
    this.#observe()
    this.#measure('registered')
    return () => {
      if (id === null && this.#root === element)
        this.#root = null
      else if (id && this.#elements.get(id) === element)
        this.#elements.delete(id)
      else
        return
      this.#observe()
      this.#measure('removed')
    }
  }

  start(): void {
    if (this.#disposed || this.#resize)
      return
    this.#resize = new ResizeObserver(this.invalidate)
    this.#mutation = new MutationObserver(this.invalidate)
    window.addEventListener('resize', this.invalidate)
    document.addEventListener('visibilitychange', this.invalidate)
    document.addEventListener('scroll', this.invalidate, true)
    this.#observe()
  }

  readonly invalidate = (): void => {
    if (!this.#resize)
      return
    if (document.visibilityState === 'hidden') {
      cancelAnimationFrame(this.#frame)
      this.#frame = 0
      this.#measure()
    }
    else if (!this.#frame) {
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0
        this.#measure()
      })
    }
  }

  #measure(kind: WorkbenchPaneChange['kind'] = 'measured'): void {
    const origin = this.#root?.getBoundingClientRect()
    const next = [...this.#elements].map(([id, element]) => {
      const rect = element.getBoundingClientRect()
      const visible = !!origin && document.visibilityState === 'visible' && element.isConnected && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      return { id, active: id === this.active(), visible, rect: visible ? { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 } }
    })
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot))
      return
    this.#snapshot = copyEventSnapshot(next)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind, snapshot: this.#snapshot }))
  }

  #observe(): void {
    this.#resize?.disconnect()
    this.#mutation?.disconnect()
    const ancestors = new Set<HTMLElement>()
    for (const element of this.#elements.values()) {
      this.#resize?.observe(element)
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) ancestors.add(parent)
    }
    for (const element of ancestors) this.#mutation?.observe(element, { attributes: true, attributeFilter: ['hidden', 'inert', 'class', 'style'] })
    if (this.#root)
      this.#resize?.observe(this.#root)
    this.invalidate()
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    cancelAnimationFrame(this.#frame)
    this.#resize?.disconnect()
    this.#mutation?.disconnect()
    this.#resize = null
    window.removeEventListener('resize', this.invalidate)
    document.removeEventListener('visibilitychange', this.invalidate)
    document.removeEventListener('scroll', this.invalidate, true)
    this.#elements.clear()
    this.#root = null
    this.#measure('removed')
    this.#changes.dispose()
  }
}
