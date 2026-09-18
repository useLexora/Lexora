import type { AutomationOccurrence } from '../../../shared/automation'
import type { AutomationOccurrenceRecord } from '../storage/automationOccurrenceRecord'
import type { AutomationService } from './AutomationService'

export interface AutomationActionExecutor {
  execute: (occurrence: AutomationOccurrenceRecord & { leaseOwner: string }) => Promise<void>
}

export class AutomationDispatcher {
  readonly #service: Pick<AutomationService, 'getOccurrence'>
  readonly #action: AutomationActionExecutor
  readonly #pending = new Map<string, Promise<void>>()

  constructor(service: Pick<AutomationService, 'getOccurrence'>, action: AutomationActionExecutor) {
    this.#service = service
    this.#action = action
  }

  dispatch(candidate: AutomationOccurrence): Promise<void> {
    const pending = this.#pending.get(candidate.id)
    if (pending)
      return pending
    const operation = Promise.resolve().then(async () => {
      const occurrence = this.#service.getOccurrence(candidate.id)
      if (!occurrence || occurrence.status !== 'queued' || occurrence.runId || !occurrence.leaseOwner)
        return
      await this.#action.execute({ ...occurrence, leaseOwner: occurrence.leaseOwner })
    }).finally(() => this.#pending.delete(candidate.id))
    this.#pending.set(candidate.id, operation)
    return operation
  }
}
