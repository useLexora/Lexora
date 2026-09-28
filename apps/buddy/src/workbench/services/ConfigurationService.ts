import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { ContributionRegistry, WorkbenchConfiguration } from './ContributionRegistry'
import { Emitter, filterEvent } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'

type ConfigurationValue = boolean | number | string
export interface ConfigurationChange {
  readonly revision: number
  readonly keys: readonly string[]
  readonly values: Readonly<Record<string, ConfigurationValue>>
}

export class ConfigurationService {
  readonly #registry: ContributionRegistry
  readonly #changes: Emitter<ConfigurationChange & { kind: 'raw' | 'effective' }>
  readonly #stopRegistry: () => void
  readonly onDidChangeRaw
  readonly onDidChangeEffective
  #descriptors = new Map<string, WorkbenchConfiguration>()
  #values: Readonly<Record<string, ConfigurationValue>> = Object.freeze({})
  #effective: Readonly<Record<string, ConfigurationValue>> = Object.freeze({})
  #revision = 0
  #effectiveRevision = 0

  constructor(registry: ContributionRegistry, onListenerError: ListenerErrorHandler = () => console.error('CONFIGURATION_OBSERVER_FAILED')) {
    this.#registry = registry
    this.#changes = new Emitter(onListenerError)
    this.onDidChangeRaw = filterEvent(this.#changes.event, change => change.kind === 'raw')
    this.onDidChangeEffective = filterEvent(this.#changes.event, change => change.kind === 'effective')
    this.#acceptDescriptors()
    this.#stopRegistry = registry.onDidChange((change) => {
      if (change.ids.configurations.length)
        this.#acceptDescriptors()
    }).dispose
  }

  get revision(): number { return this.#revision }
  get effectiveRevision(): number { return this.#effectiveRevision }
  get(id: string): ConfigurationValue | undefined { return this.#effective[id] }

  set(id: string, value: ConfigurationValue): void {
    const descriptor = this.#descriptors.get(id)
    if (!descriptor || !descriptor.validate(value))
      throw new Error('Invalid workbench configuration')
    this.restore({ ...this.#values, [id]: value })
  }

  restore(values: Readonly<Record<string, ConfigurationValue>>): void {
    const keys = this.#diff(this.#values, values)
    if (!keys.length)
      return
    const next = this.#computeEffective(this.#descriptors, values)
    this.#values = copyEventSnapshot(values)
    const raw = copyEventSnapshot({ revision: ++this.#revision, keys, values: this.#values })
    const effective = this.#updateEffective(next)
    this.#changes.fireBatch([{ ...raw, kind: 'raw' }, ...(effective ? [{ ...effective, kind: 'effective' as const }] : [])])
  }

  snapshot(): Readonly<Record<string, ConfigurationValue>> { return this.#values }

  subscribe(listener: () => void): () => void {
    return this.onDidChangeEffective(listener).dispose
  }

  dispose(): void {
    this.#stopRegistry()
    this.#changes.dispose()
  }

  #acceptDescriptors(): void {
    const descriptors = new Map(this.#registry.configurations)
    const next = this.#computeEffective(descriptors, this.#values)
    this.#descriptors = descriptors
    const change = this.#updateEffective(next)
    if (change)
      this.#changes.fire(Object.freeze({ ...change, kind: 'effective' }))
  }

  #computeEffective(descriptors: ReadonlyMap<string, WorkbenchConfiguration>, values: Readonly<Record<string, ConfigurationValue>>): Readonly<Record<string, ConfigurationValue>> {
    return Object.fromEntries([...descriptors].map(([id, descriptor]) => {
      const value = values[id]
      return [id, value !== undefined && descriptor.validate(value) ? value : descriptor.defaultValue]
    }))
  }

  #updateEffective(next: Readonly<Record<string, ConfigurationValue>>): ConfigurationChange | null {
    const keys = this.#diff(this.#effective, next)
    if (!keys.length)
      return null
    this.#effective = copyEventSnapshot(next)
    return copyEventSnapshot({ revision: ++this.#effectiveRevision, keys, values: this.#effective })
  }

  #diff(previous: Readonly<Record<string, ConfigurationValue>>, next: Readonly<Record<string, ConfigurationValue>>): string[] {
    return [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(key => previous[key] !== next[key])
  }
}
