export type ContextValue = boolean | string | number

export class ContextKeyService {
  readonly #values = new Map<string, { value: ContextValue }>()
  readonly #parent?: ContextKeyService

  constructor(parent?: ContextKeyService) {
    this.#parent = parent
  }

  set(key: string, value: ContextValue): () => void {
    const entry = { value }
    this.#values.set(key, entry)
    return () => {
      if (this.#values.get(key) === entry)
        this.#values.delete(key)
    }
  }

  snapshot(): Record<string, ContextValue> {
    return { ...this.#parent?.snapshot(), ...Object.fromEntries([...this.#values].map(([key, entry]) => [key, entry.value])) }
  }

  child(): ContextKeyService {
    return new ContextKeyService(this)
  }
}
