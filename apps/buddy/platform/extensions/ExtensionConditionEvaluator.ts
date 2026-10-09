import type { ExtensionConditionContext } from '../../shared/extensions/extensionConditionContext'
import type { ExtensionConditionDefinition, ExtensionConditionInput, ExtensionConditionReference, ExtensionConditionsChanged, ExtensionConditionState } from '../../shared/extensions/extensionConditions'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionHost } from './ExtensionService'
import { createHash, randomUUID } from 'node:crypto'
import { Emitter } from '../../shared/events/Emitter'
import { extensionConditionResultSchema } from '../../shared/extensions/extensionConditions'

interface Identity {
  extensionId: string
  condition: string
  scopeKey: string
  taskId?: string
  inputs: readonly ExtensionConditionInput[]
}
interface Operation extends Identity { controller: AbortController }
interface Evaluation { controller: AbortController, consumers: number, result: Promise<ExtensionConditionState> }
interface Snapshot {
  generation: string
  context: ExtensionConditionContext
  host: ExtensionHost
  signal: AbortSignal
}
interface Invalidation {
  extensionId?: string
  condition?: string
  scopeKey?: string
  taskId?: string
  inputs?: readonly ExtensionConditionInput[]
}
const unavailable: ExtensionConditionState = { status: 'unavailable', value: false }

export class ExtensionConditionInvalidatedError extends Error {
  constructor() { super('EXTENSION_CONDITION_STALE') }
}

export class ExtensionConditionEvaluator {
  readonly #changes = new Emitter<ExtensionConditionsChanged>(() => {})
  readonly onDidInvalidate = this.#changes.event
  readonly #pending = new Set<Operation>()
  readonly #waiting = new Map<Operation, () => void>()
  readonly #cache = new Map<string, { identity: Identity, state: ExtensionConditionState }>()
  readonly #evaluations = new Map<string, Evaluation>()
  readonly #stop = new AbortController()
  #revision = 0
  #active = 0

  async evaluate(input: {
    extensionId: string
    definition: ExtensionConditionDefinition
    reference: ExtensionConditionReference
    scopeKey: string
    taskId?: string
    signal?: AbortSignal
    cache: boolean
    snapshot: (signal: AbortSignal) => Promise<Snapshot>
  }): Promise<ExtensionConditionState> {
    if (this.#stop.signal.aborted)
      return unavailable
    const operation: Operation = { extensionId: input.extensionId, condition: input.definition.id, scopeKey: input.scopeKey, taskId: input.taskId, inputs: input.definition.inputs, controller: new AbortController() }
    const signal = AbortSignal.any([operation.controller.signal, this.#stop.signal, ...input.signal ? [input.signal] : []])
    this.#pending.add(operation)
    let evaluation: Evaluation | undefined
    let release: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      release = await this.#acquire(operation, signal)
      signal.throwIfAborted()
      timeout = setTimeout(() => operation.controller.abort(), 5000)
      const snapshot = await waitFor(input.snapshot(signal), signal)
      const abort = AbortSignal.any([signal, snapshot.signal])
      abort.throwIfAborted()
      const key = conditionRevision({ extensionId: input.extensionId, generation: snapshot.generation, reference: input.reference, context: snapshot.context })
      const cached = input.cache ? this.#cache.get(key) : undefined
      if (cached)
        return cached.state
      evaluation = input.cache ? this.#evaluations.get(key) : undefined
      if (!evaluation || evaluation.controller.signal.aborted) {
        const controller = new AbortController()
        const result = this.#execute(snapshot, input.reference, AbortSignal.any([controller.signal, this.#stop.signal, snapshot.signal]))
        evaluation = { controller, consumers: 0, result }
        if (input.cache) {
          this.#evaluations.set(key, evaluation)
          const current = evaluation
          void result.finally(() => {
            if (this.#evaluations.get(key) === current)
              this.#evaluations.delete(key)
          }).catch(() => {})
        }
      }
      evaluation.consumers++
      const state = await waitFor(evaluation.result, abort)
      abort.throwIfAborted()
      if (input.cache) {
        this.#cache.set(key, { identity: operation, state })
        if (this.#cache.size > 512)
          this.#cache.delete(this.#cache.keys().next().value!)
      }
      return state
    }
    catch (error) {
      if (!input.cache && error instanceof ExtensionConditionInvalidatedError)
        throw error
      return unavailable
    }
    finally {
      clearTimeout(timeout)
      this.#pending.delete(operation)
      if (evaluation && --evaluation.consumers === 0)
        evaluation.controller.abort()
      release?.()
    }
  }

  #acquire(operation: Operation, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.#waiting.size >= 1024)
      return Promise.reject(new Error('EXTENSION_REQUEST_LIMIT'))
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#waiting.delete(operation)
        reject(signal.reason)
      }
      const start = () => {
        this.#waiting.delete(operation)
        signal.removeEventListener('abort', cancel)
        this.#active++
        resolve(() => {
          this.#active--
          this.#waiting.values().next().value?.()
        })
      }
      if (this.#active < 32) {
        start()
      }
      else {
        this.#waiting.set(operation, start)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
  }

  async #execute(snapshot: Snapshot, reference: ExtensionConditionReference, signal: AbortSignal): Promise<ExtensionConditionState> {
    const evaluationId = randomUUID()
    const cancel = () => {
      void snapshot.host.call('conditions.cancel', { evaluationId }).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const result = await waitFor(snapshot.host.call('conditions.evaluate', { evaluationId, condition: reference.condition, context: snapshot.context, params: reference.params } as JsonValue), signal)
      signal.throwIfAborted()
      return { status: 'ready', ...extensionConditionResultSchema.parse(result) }
    }
    finally { signal.removeEventListener('abort', cancel) }
  }

  invalidate(input: Invalidation, extensions: readonly string[] = []): void {
    const matches = (identity: Identity) => (!input.extensionId || identity.extensionId === input.extensionId)
      && (!input.condition || identity.condition === input.condition)
      && (!input.scopeKey || identity.scopeKey === input.scopeKey)
      && (!input.taskId || identity.taskId === input.taskId)
      && (!input.inputs || identity.inputs.some(source => input.inputs!.includes(source)))
    const affected = new Set(input.extensionId ? [input.extensionId] : extensions)
    for (const operation of this.#pending) {
      if (matches(operation)) {
        affected.add(operation.extensionId)
        operation.controller.abort(new ExtensionConditionInvalidatedError())
      }
    }
    for (const [key, cached] of this.#cache) {
      if (matches(cached.identity)) {
        affected.add(cached.identity.extensionId)
        this.#cache.delete(key)
      }
    }
    for (const extensionId of affected)
      this.#changes.fire({ extensionId, revision: ++this.#revision, ...(input.condition ? { condition: input.condition } : {}), ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}) })
  }

  dispose(): void {
    this.#stop.abort()
    this.#cache.clear()
    this.#changes.dispose()
  }
}

export function conditionRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
  })
  try {
    return await Promise.race([pending, cancelled])
  }
  finally { signal.removeEventListener('abort', abort) }
}
