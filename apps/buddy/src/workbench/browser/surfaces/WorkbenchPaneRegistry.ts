import type { WorkbenchPaneSnapshot } from '@buddy-shared/workbench/workbenchInteraction'

export class WorkbenchPaneRegistry {
  readonly #elements = new Map<string, HTMLElement>()
  readonly #listeners = new Set<() => void>()
  #root: HTMLElement | null = null
  #snapshot: WorkbenchPaneSnapshot[] = []
  #resize: ResizeObserver | null = null
  #mutation: MutationObserver | null = null
  #frame = 0
  constructor(readonly active: () => string) {}

  get snapshot(): WorkbenchPaneSnapshot[] { return this.#snapshot }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  register(id: string | null, element: HTMLElement): () => void {
    if (id === null)
      this.#root = element
    else
      this.#elements.set(id, element)
    this.#observe()
    return () => {
      if (id === null && this.#root === element)
        this.#root = null
      else if (id && this.#elements.get(id) === element)
        this.#elements.delete(id)
      this.#observe()
    }
  }

  start(): void {
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

  #measure(): void {
    const origin = this.#root?.getBoundingClientRect()
    const next = [...this.#elements].map(([id, element]) => {
      const rect = element.getBoundingClientRect()
      const visible = !!origin && document.visibilityState === 'visible' && element.isConnected && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      return { id, active: id === this.active(), visible, rect: visible ? { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 } }
    })
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot))
      return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
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
    cancelAnimationFrame(this.#frame)
    this.#resize?.disconnect()
    this.#mutation?.disconnect()
    this.#resize = null
    window.removeEventListener('resize', this.invalidate)
    document.removeEventListener('visibilitychange', this.invalidate)
    document.removeEventListener('scroll', this.invalidate, true)
    this.#listeners.clear()
  }
}
