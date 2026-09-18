import type { ContributionRegistry } from './ContributionRegistry'

export class ConfigurationService {
  readonly #registry: ContributionRegistry
  readonly #listeners = new Set<() => void>()
  #values: Record<string, boolean | number | string> = {}

  constructor(registry: ContributionRegistry) {
    this.#registry = registry
  }

  get(id: string): boolean | number | string | undefined {
    const descriptor = this.#registry.configurations.get(id)
    const value = this.#values[id]
    return descriptor && value !== undefined && descriptor.validate(value) ? value : descriptor?.defaultValue
  }

  set(id: string, value: boolean | number | string): void {
    const descriptor = this.#registry.configurations.get(id)
    if (!descriptor || !descriptor.validate(value))
      throw new Error('Invalid workbench configuration')
    this.#values = { ...this.#values, [id]: value }
    for (const listener of this.#listeners)
      listener()
  }

  restore(values: Record<string, boolean | number | string>): void {
    this.#values = { ...values }
  }

  snapshot(): Record<string, boolean | number | string> {
    return { ...this.#values }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
