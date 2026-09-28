import type { AutomationOccurrence } from '../../../shared/automation'
import type { AutomationOccurrenceRecord } from '../storage/automationOccurrenceRecord'
import type { AutomationService } from './AutomationService'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface AutomationActionExecutor {
  execute: (occurrence: AutomationOccurrenceRecord & { leaseOwner: string }, signal?: AbortSignal) => Promise<void>
}

export type AutomationDispatchChange = Readonly<
  | { kind: 'started' | 'returned' | 'failed', automationId: string, occurrenceId: string }
  | { kind: 'stopping' | 'drained', count: number }
>

export class AutomationDispatcher {
  readonly #service: Pick<AutomationService, 'getOccurrence'>
  readonly #action: AutomationActionExecutor
  readonly #pending = new Map<string, Promise<void>>()
  readonly #stopping = new AbortController()
  readonly #changes: Emitter<AutomationDispatchChange>
  readonly onDidChange: Emitter<AutomationDispatchChange>['event']

  constructor(service: Pick<AutomationService, 'getOccurrence'>, action: AutomationActionExecutor, onObserverError: (error: unknown) => void = () => {}) {
    this.#service = service
    this.#action = action
    this.#changes = new Emitter(onObserverError)
    this.onDidChange = this.#changes.event
  }

  dispatch(candidate: AutomationOccurrence): Promise<void> {
    if (this.#stopping.signal.aborted)
      return Promise.reject(new DOMException('Automation dispatch is stopping', 'AbortError'))
    const id = candidate.id
    const pending = this.#pending.get(id)
    if (pending)
      return pending
    const operation = Promise.resolve().then(async () => {
      this.#stopping.signal.throwIfAborted()
      const occurrence = this.#service.getOccurrence(id)
      if (!occurrence || occurrence.status !== 'queued' || occurrence.runId || !occurrence.leaseOwner)
        return
      const identity = { automationId: occurrence.automationId, occurrenceId: occurrence.id }
      this.#changes.fire(copyEventSnapshot({ kind: 'started', ...identity }))
      try {
        await this.#action.execute({ ...occurrence, leaseOwner: occurrence.leaseOwner }, this.#stopping.signal)
        this.#changes.fire(copyEventSnapshot({ kind: 'returned', ...identity }))
      }
      catch (error) {
        this.#changes.fire(copyEventSnapshot({ kind: 'failed', ...identity }))
        throw error
      }
    }).finally(() => this.#pending.delete(id))
    this.#pending.set(id, operation)
    return operation
  }

  stop(): void {
    if (this.#stopping.signal.aborted)
      return
    this.#stopping.abort(new DOMException('Automation dispatch is stopping', 'AbortError'))
    this.#changes.fire(copyEventSnapshot({ kind: 'stopping', count: this.#pending.size }))
  }

  async dispose(): Promise<void> {
    this.stop()
    await Promise.allSettled([...this.#pending.values()])
    this.#changes.fire(copyEventSnapshot({ kind: 'drained', count: 0 }))
    this.#changes.dispose()
  }
}
