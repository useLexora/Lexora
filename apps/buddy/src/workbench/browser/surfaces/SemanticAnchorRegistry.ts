import type { ComposerActivity, WorkbenchAnchor } from '@buddy-shared/workbench/workbenchUi'
import type { SemanticAnchor, WorkbenchAnchors } from '@/shared/ui/contributions/workbenchUiContext'
import { shallowReactive } from 'vue'

export class SemanticAnchorRegistry implements WorkbenchAnchors {
  readonly entries = shallowReactive(new Map<string, SemanticAnchor>())
  readonly #listeners = new Set<(anchor: SemanticAnchor, activity: ComposerActivity) => void>()
  readonly #cleanup = new Set<() => void>()

  register(kind: WorkbenchAnchor, element: HTMLElement, caret?: () => DOMRect | null): () => void {
    const anchor: SemanticAnchor = { id: crypto.randomUUID(), kind, element, caret }
    this.entries.set(anchor.id, anchor)
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
      cancelAnimationFrame(frame)
      element.removeEventListener('input', input)
      this.entries.delete(anchor.id)
      this.#cleanup.delete(dispose)
    }
    this.#cleanup.add(dispose)
    return dispose
  }

  #activity(anchor: SemanticAnchor, position: DOMRect | null | undefined): void {
    const bounds = anchor.element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0)
      return
    const cursor = position
      ? { x: Math.max(0, Math.min(bounds.width, position.left - bounds.left)), y: Math.max(0, Math.min(bounds.height, position.top - bounds.top)), width: Math.max(1, Math.min(bounds.width, position.width)), height: Math.min(bounds.height, Math.max(0, position.height)) }
      : null
    for (const listener of this.#listeners) listener(anchor, { type: 'composer-input', caret: cursor })
  }

  onActivity(listener: (anchor: SemanticAnchor, activity: ComposerActivity) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    for (const dispose of this.#cleanup) dispose()
    this.#listeners.clear()
  }
}
