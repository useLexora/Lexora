import type { EventMessage, EventName, EventPattern, EventSubscriber, EventSubscription, EventSubscriptionOptions } from './eventTypes'
import { EventEmitter2 } from 'eventemitter2'
import { copyEventSnapshot } from './eventSnapshot'

export class EventBus<Events extends object> implements EventSubscriber<Events> {
  readonly #emitter = new EventEmitter2({ wildcard: true, delimiter: ':', maxListeners: 64 })
  readonly #subscriptions = new Set<EventSubscription>()
  readonly #onListenerError: (error: unknown, event: EventMessage<Events>) => void
  readonly #pending: { event: EventMessage<Events>, listeners: ReturnType<EventEmitter2['listeners']> }[] = []
  #delivering = false
  #disposed = false

  constructor(onListenerError: (error: unknown, event: EventMessage<Events>) => void) {
    this.#onListenerError = onListenerError
  }

  readonly subscriber: EventSubscriber<Events> = Object.freeze({ on: this.on.bind(this) })

  on<const Pattern extends EventPattern<Events>>(patterns: Pattern | readonly Pattern[], listener: (event: EventMessage<Events, Pattern>) => unknown, options: EventSubscriptionOptions = {}): EventSubscription {
    if (this.#disposed)
      throw new Error('EVENT_BUS_DISPOSED')
    const names = [...new Set(typeof patterns === 'string' ? [patterns] : patterns)]
    if (names.some(pattern => typeof pattern !== 'string' || !/^(?:[a-z][a-z0-9-]*:)*(?:[a-z][a-z0-9-]*|\*|\*\*)$/.test(pattern) || pattern.split(':').some(part => part === 'constructor' || part === 'prototype')))
      throw new Error('EVENT_PATTERN_INVALID')
    if (typeof listener !== 'function')
      throw new TypeError('EVENT_LISTENER_INVALID')
    if (!names.length || options.signal?.aborted)
      return { dispose() {} }
    let active = true
    let subscription: EventSubscription
    const wrapped = (event: EventMessage<Events, Pattern>) => {
      if (!active)
        return
      if (options.once)
        subscription.dispose()
      return listener(event)
    }
    subscription = { dispose: () => {
      if (!active)
        return
      active = false
      for (const name of names) this.#emitter.off(name, wrapped)
      this.#subscriptions.delete(subscription)
      options.signal?.removeEventListener('abort', subscription.dispose)
    } }
    for (const name of names) this.#emitter.on(name, wrapped)
    this.#subscriptions.add(subscription)
    options.signal?.addEventListener('abort', subscription.dispose, { once: true })
    return subscription
  }

  hasListeners(name: EventName<Events>): boolean {
    return this.#subscriptions.size > 0 && Boolean(this.#emitter.hasListeners(name))
  }

  emit(message: EventMessage<Events>): boolean {
    if (!this.#subscriptions.size || this.#disposed)
      return false
    const listeners = [...new Set(this.#emitter.listeners(message.type))]
    if (!listeners.length)
      return false
    this.#pending.push({ event: copyEventSnapshot(message) as EventMessage<Events>, listeners })
    if (this.#delivering)
      return true
    this.#delivering = true
    try {
      for (let index = 0; index < this.#pending.length; index++) {
        const { event, listeners } = this.#pending[index]!
        for (const listener of listeners) {
          try {
            const result: unknown = listener(event)
            if (result !== undefined)
              void Promise.resolve(result).catch(error => this.#report(error, event))
          }
          catch (error) { this.#report(error, event) }
        }
      }
    }
    finally {
      this.#pending.length = 0
      this.#delivering = false
    }
    return true
  }

  dispose(): void {
    this.#disposed = true
    for (const subscription of this.#subscriptions)
      subscription.dispose()
  }

  #report(error: unknown, event: EventMessage<Events>): void {
    try {
      this.#onListenerError(error, event)
    }
    catch {}
  }
}
