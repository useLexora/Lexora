import type { LifecycleComponent, ServiceLifecycleReader } from './serviceLifecycle'
import { readLifecycleFailure } from './lifecycleFailure'
import { lifecycleComponentSchema } from './serviceLifecycle'
import { ServiceLifecycleSource } from './ServiceLifecycleSource'

type Cleanup = () => void | Promise<void>

export interface ServiceScope {
  defer: (cleanup: Cleanup) => void
}

interface Component {
  kind: 'service' | 'operation'
  id: string
  operationId: string
  cleanups: Cleanup[]
  status: 'starting' | 'ready' | 'failed' | 'stopped'
  pending: Promise<unknown> | null
}

export class ServiceHost {
  readonly lifecycle: ServiceLifecycleReader
  readonly #lifecycle: ServiceLifecycleSource
  readonly #components = new Map<string, Component>()
  #stopping = false
  #stopPromise: Promise<void> | null = null

  constructor(lifecycle = new ServiceLifecycleSource()) {
    this.#lifecycle = lifecycle
    this.lifecycle = lifecycle.reader
  }

  start<T>(id: string, initialize: (scope: ServiceScope) => T | Promise<T>, dependencies: readonly string[] = []): Promise<T> {
    return this.#start(id, initialize, dependencies, 'service')
  }

  step<T>(id: string, initialize: () => T | Promise<T>, dependencies: readonly string[] = []): Promise<T> {
    return this.#start(id, initialize, dependencies, 'operation')
  }

  #start<T>(id: string, initialize: (scope: ServiceScope) => T | Promise<T>, dependencies: readonly string[], kind: Component['kind']): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new Error('Service host is stopping'))
    if (this.#components.has(id))
      return Promise.reject(new Error(`Component already registered: ${id}`))
    lifecycleComponentSchema.shape.component.parse(id)
    for (const dependency of dependencies) {
      if (this.#components.get(dependency)?.status !== 'ready')
        return Promise.reject(new Error(`Component dependency is not ready: ${dependency}`))
    }
    const component: Component = {
      kind,
      id,
      operationId: crypto.randomUUID(),
      cleanups: [],
      status: 'starting',
      pending: null,
    }
    const startedAt = performance.now()
    const pending = Promise.resolve().then(() => initialize({
      defer: cleanup => component.cleanups.push(cleanup),
    })).then((value) => {
      component.status = 'ready'
      if (kind === 'operation' || !this.#stopping)
        this.#publish(component, 'ready', startedAt)
      return value
    }, (error: unknown) => {
      component.status = 'failed'
      this.#publish(component, 'start_failed', startedAt, error)
      throw error
    })
    component.pending = pending
    this.#components.set(id, component)
    if (kind === 'service')
      this.#publish(component, 'registered')
    this.#publish(component, 'starting')
    return pending
  }

  stop(): Promise<void> {
    if (this.#stopPromise)
      return this.#stopPromise
    this.#stopping = true
    this.#stopPromise = Promise.resolve().then(() => this.#stop())
    this.#lifecycle.stopping()
    return this.#stopPromise
  }

  async #stop(): Promise<void> {
    const failures: unknown[] = []
    for (const component of [...this.#components.values()].reverse()) {
      await component.pending?.catch(() => {})
      if (component.kind === 'operation')
        continue
      const startedAt = performance.now()
      this.#publish(component, 'stopping')
      const componentFailures: unknown[] = []
      for (const cleanup of component.cleanups.splice(0).reverse()) {
        try {
          await cleanup()
        }
        catch (error) {
          componentFailures.push(error)
        }
      }
      component.status = componentFailures.length ? 'failed' : 'stopped'
      if (componentFailures.length) {
        const error = new AggregateError(componentFailures, 'Component cleanup failed')
        this.#publish(component, 'stop_failed', startedAt, error)
        failures.push(error)
      }
      else {
        this.#publish(component, 'stopped', startedAt)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Service host cleanup failed')
  }

  #publish(component: Component, status: LifecycleComponent['status'], startedAt?: number, error?: unknown): void {
    this.#lifecycle.update({
      component: component.id,
      kind: component.kind,
      operationId: component.operationId,
      status,
      ...(startedAt === undefined ? {} : { durationMs: Math.round(performance.now() - startedAt) }),
      ...(error === undefined ? {} : { failure: readLifecycleFailure(error) }),
    })
  }
}
