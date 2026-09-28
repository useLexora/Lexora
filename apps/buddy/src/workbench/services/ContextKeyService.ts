import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'

export type ContextValue = boolean | string | number
export interface ContextKeyChange {
  readonly revision: number
  readonly keys: readonly string[]
  readonly values: Readonly<Record<string, ContextValue>>
}
export interface ContextKeyLease {
  update: (values: Readonly<Record<string, ContextValue>>) => void
  dispose: () => void
}

export class ContextKeyService {
  readonly #values = new Map<string, { value: ContextValue, lease: object }>()
  readonly #parent?: ContextKeyService
  readonly #changes: Emitter<ContextKeyChange>
  readonly #stopParent?: () => void
  readonly #onListenerError: ListenerErrorHandler
  readonly onDidChange
  #snapshot: Readonly<Record<string, ContextValue>> = Object.freeze({})
  #revision = 0
  #disposed = false

  constructor(parent?: ContextKeyService, onListenerError: ListenerErrorHandler = () => console.error('CONTEXT_OBSERVER_FAILED')) {
    this.#parent = parent
    this.#onListenerError = onListenerError
    this.#changes = new Emitter(onListenerError)
    this.onDidChange = this.#changes.event
    this.#snapshot = copyEventSnapshot(parent?.snapshot() ?? {})
    this.#stopParent = parent?.onDidChange(() => this.#publish()).dispose
  }

  get revision(): number { return this.#revision }

  set(key: string, value: ContextValue): () => void {
    const lease = this.bind({ [key]: value })
    return lease.dispose
  }

  bind(values: Readonly<Record<string, ContextValue>> = {}): ContextKeyLease {
    if (this.#disposed)
      throw new Error('CONTEXT_KEYS_DISPOSED')
    const identity = {}
    let active = true
    const update = (values: Readonly<Record<string, ContextValue>>) => {
      if (!active || this.#disposed)
        return
      for (const [key, entry] of this.#values) {
        if (entry.lease === identity && !Object.hasOwn(values, key))
          this.#values.delete(key)
      }
      for (const [key, value] of Object.entries(values))
        this.#values.set(key, { value, lease: identity })
      this.#publish()
    }
    update(values)
    return { update, dispose: () => {
      if (!active)
        return
      active = false
      for (const [key, entry] of this.#values) {
        if (entry.lease === identity)
          this.#values.delete(key)
      }
      this.#publish()
    } }
  }

  snapshot(): Readonly<Record<string, ContextValue>> { return this.#snapshot }

  child(): ContextKeyService { return new ContextKeyService(this, this.#onListenerError) }

  dispose(): void {
    this.#disposed = true
    this.#stopParent?.()
    this.#changes.dispose()
  }

  #publish(): void {
    if (this.#disposed)
      return
    const next = { ...this.#parent?.snapshot(), ...Object.fromEntries([...this.#values].map(([key, entry]) => [key, entry.value])) }
    const keys = [...new Set([...Object.keys(this.#snapshot), ...Object.keys(next)])].filter(key => this.#snapshot[key] !== next[key])
    if (!keys.length)
      return
    this.#snapshot = copyEventSnapshot(next)
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, keys, values: this.#snapshot }))
  }
}
