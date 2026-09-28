import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { EditTurnRequestInput, PrepareTurnRequestInput, RegenerateTurnRequestInput, RetryInterruptedTurnRequestInput, TurnCommitFact, TurnRequestRecord, TurnRequestRepository } from '../storage/turnRequestRepository'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type TurnRequestCommit = EventSnapshot<{
  commitId: string
  requestId: string
  runId: string
  conversationId: string
  branchId: string
  facts: readonly TurnCommitFact[]
}>

export class TurnRequestService implements TurnRequestRepository {
  readonly #repository: TurnRequestRepository
  readonly #committed: Emitter<TurnRequestCommit>
  readonly onDidCommit: Emitter<TurnRequestCommit>['event']
  #disposed = false

  constructor(repository: TurnRequestRepository, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  findByRequestId(requestId: string) {
    return this.#repository.findByRequestId(requestId)
  }

  prepare(input: PrepareTurnRequestInput) {
    return this.#commit(() => this.#repository.prepare(input))
  }

  edit(input: EditTurnRequestInput) {
    return this.#commit(() => this.#repository.edit(input))
  }

  regenerate(input: RegenerateTurnRequestInput) {
    return this.#commit(() => this.#repository.regenerate(input))
  }

  retryInterrupted(input: RetryInterruptedTurnRequestInput) {
    return this.#commit(() => this.#repository.retryInterrupted(input))
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }

  #commit(operation: () => TurnRequestRecord): TurnRequestRecord {
    if (this.#disposed)
      throw new Error('Turn request service is stopped')
    const request = operation()
    if (request.created && request.committedFacts?.length)
      this.#committed.fire(copyEventSnapshot({ commitId: request.runId, requestId: request.requestId, runId: request.runId, conversationId: request.conversationId, branchId: request.branchId, facts: request.committedFacts }))
    return request
  }
}
