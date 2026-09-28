import type { EventSubscription, EventSubscriptionOptions } from './eventTypes'

export type Event<Value> = (listener: (value: Value) => unknown, options?: EventSubscriptionOptions) => EventSubscription
export type ListenerErrorHandler = (error: unknown) => void

interface Listener<Value> {
  active: boolean
  callback: (value: Value) => unknown
  subscription: EventSubscription
  once: boolean
}

export class Emitter<Value> {
  readonly #listeners = new Set<Listener<Value>>()
  readonly #pending: { value: Value, listeners: Listener<Value>[] }[] = []
  readonly #onListenerError: ListenerErrorHandler
  #delivering = false
  #disposed = false

  constructor(onListenerError: ListenerErrorHandler) {
    this.#onListenerError = onListenerError
  }

  readonly event: Event<Value> = (callback, options = {}) => {
    if (this.#disposed || options.signal?.aborted)
      return { dispose() {} }
    const listener: Listener<Value> = {
      active: true,
      callback,
      once: options.once ?? false,
      subscription: { dispose: () => {
        if (!listener.active)
          return
        listener.active = false
        this.#listeners.delete(listener)
        options.signal?.removeEventListener('abort', listener.subscription.dispose)
      } },
    }
    this.#listeners.add(listener)
    options.signal?.addEventListener('abort', listener.subscription.dispose, { once: true })
    return listener.subscription
  }

  fire(value: Value): void {
    this.fireBatch([value])
  }

  fireBatch(values: readonly Value[]): void {
    if (this.#disposed)
      return
    for (const value of values)
      this.#pending.push({ value, listeners: [...this.#listeners] })
    if (this.#delivering)
      return
    this.#delivering = true
    try {
      for (let index = 0; index < this.#pending.length; index++) {
        const delivery = this.#pending[index]!
        for (const listener of delivery.listeners) {
          if (!listener.active)
            continue
          if (listener.once)
            listener.subscription.dispose()
          try {
            const result = listener.callback(delivery.value)
            if (result !== undefined)
              void Promise.resolve(result).catch(error => this.#report(error))
          }
          catch (error) {
            this.#report(error)
          }
        }
      }
    }
    finally {
      this.#pending.length = 0
      this.#delivering = false
    }
  }

  dispose(): void {
    this.#disposed = true
    for (const listener of this.#listeners)
      listener.subscription.dispose()
  }

  #report(error: unknown): void {
    try {
      this.#onListenerError(error)
    }
    catch {}
  }
}

export function filterEvent<Value, Selected extends Value>(event: Event<Value>, predicate: (value: Value) => value is Selected): Event<Selected>
export function filterEvent<Value>(event: Event<Value>, predicate: (value: Value) => boolean): Event<Value>
export function filterEvent<Value>(event: Event<Value>, predicate: (value: Value) => boolean): Event<Value> {
  return (listener, options) => {
    const subscription = event((value) => {
      if (!predicate(value))
        return
      if (options?.once)
        subscription.dispose()
      return listener(value)
    }, { ...options, once: false })
    return subscription
  }
}

export function mapEvent<Value, Mapped>(event: Event<Value>, map: (value: Value) => Mapped): Event<Mapped> {
  return (listener, options) => event(value => listener(map(value)), options)
}
