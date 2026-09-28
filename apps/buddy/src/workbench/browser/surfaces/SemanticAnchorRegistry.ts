import type { ComposerActivity, WorkbenchAnchor } from '@buddy-shared/workbench/workbenchUi'
import type { SemanticAnchor, WorkbenchAnchors } from '@/shared/ui/contributions/workbenchUiContext'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { ReadonlyMapView } from '@buddy-shared/events/ReadonlyMapView'
import { shallowReactive } from 'vue'

export class SemanticAnchorRegistry implements WorkbenchAnchors {
  readonly #entries = shallowReactive(new Map<string, SemanticAnchor>())
  readonly entries = new ReadonlyMapView(this.#entries)
  readonly #changes = new Emitter<{ readonly revision: number, readonly kind: 'registered' | 'removed', readonly anchor: SemanticAnchor }>(() => console.error('ANCHOR_OBSERVER_FAILED'))
  readonly #activities = new Emitter<{ readonly anchor: SemanticAnchor, readonly activity: ComposerActivity }>(() => console.error('ANCHOR_ACTIVITY_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly onDidActivity = this.#activities.event
  #revision = 0
  #disposed = false
  readonly #cleanup = new Set<() => void>()

  register(kind: WorkbenchAnchor, element: HTMLElement, caret?: () => DOMRect | null): () => void {
    if (this.#disposed)
      throw new Error('WORKBENCH_ANCHORS_DISPOSED')
    const anchor: SemanticAnchor = Object.freeze({ id: crypto.randomUUID(), kind, element, caret })
    this.#entries.set(anchor.id, anchor)
    let frame = 0
    let lastActivity = 0
    const input = (event: Event) => {
      if (!event.isTrusted || kind !== 'composer.input' || performance.now() - lastActivity < 50 || document.visibilityState !== 'visible' || !document.hasFocus() || matchMedia('(prefers-reduced-motion: reduce)').matches)
        return
      if (frame)
        return
      const pane = [...this.entries.values()].find(candidate => candidate.kind === 'workbench.pane' && candidate.element.contains(element))
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!element.isConnected || !element.contains(document.activeElement) || element.closest('[inert], [hidden]') || document.visibilityState !== 'visible' || !document.hasFocus() || matchMedia('(prefers-reduced-motion: reduce)').matches)
          return
        lastActivity = performance.now()
        const position = caret?.()
        this.#activity(anchor, position)
        if (pane && this.entries.get(pane.id) === pane && pane.element.contains(element))
          this.#activity(pane, position)
      })
    }
    element.addEventListener('input', input)
    const dispose = () => {
      if (this.#entries.get(anchor.id) !== anchor)
        return
      cancelAnimationFrame(frame)
      element.removeEventListener('input', input)
      this.#entries.delete(anchor.id)
      this.#cleanup.delete(dispose)
      this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'removed', anchor }))
    }
    this.#cleanup.add(dispose)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'registered', anchor }))
    return dispose
  }

  #activity(anchor: SemanticAnchor, position: DOMRect | null | undefined): void {
    const bounds = anchor.element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0)
      return
    const cursor = position
      ? { x: Math.max(0, Math.min(bounds.width, position.left - bounds.left)), y: Math.max(0, Math.min(bounds.height, position.top - bounds.top)), width: Math.max(1, Math.min(bounds.width, position.width)), height: Math.min(bounds.height, Math.max(0, position.height)) }
      : null
    this.#activities.fire(Object.freeze({ anchor, activity: copyEventSnapshot<ComposerActivity>({ type: 'composer-input', caret: cursor }) }))
  }

  onActivity(listener: (anchor: SemanticAnchor, activity: ComposerActivity) => void): () => void {
    return this.onDidActivity(event => listener(event.anchor, event.activity)).dispose
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    for (const dispose of this.#cleanup) dispose()
    this.#changes.dispose()
    this.#activities.dispose()
  }
}
