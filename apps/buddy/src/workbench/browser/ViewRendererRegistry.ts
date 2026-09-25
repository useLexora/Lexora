import type { Component } from 'vue'
import { shallowReactive } from 'vue'

export class ViewRendererRegistry {
  readonly #renderers = shallowReactive(new Map<string, { renderer: Component }>())

  register(id: string, renderer: Component): () => void {
    if (this.#renderers.has(id))
      throw new Error(`View renderer already registered: ${id}`)
    const entry = { renderer }
    this.#renderers.set(id, entry)
    return () => {
      if (this.#renderers.get(id) === entry)
        this.#renderers.delete(id)
    }
  }

  resolve(id: string): Component | undefined {
    return this.#renderers.get(id)?.renderer
  }
}
