import type { DatabaseSync } from 'node:sqlite'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { RunEventAvailability } from '../events/RunEventPorts'
import type { SqliteRunEventWriter } from '../events/SqliteRunEventWriter'
import type { EditTurnRequestInput, PrepareQuestionReplyInput, PrepareTurnRequestInput, RegenerateTurnRequestInput, RetryInterruptedTurnRequestInput, TurnCommitFact, TurnRequestRecord, TurnRequestRepository } from '../storage/turnRequestRepository'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { afterTransactionCommit, withTransaction } from '../storage/transaction'
import { createTurnRequestRepository } from '../storage/turnRequestRepository'

export type TurnRequestCommit = EventSnapshot<{
  commitId: string
  requestId: string
  runId: string
  conversationId: string
  branchId: string
  facts: readonly TurnCommitFact[]
}>

export class TurnRequestService implements TurnRequestRepository {
  readonly #events?: SqliteRunEventWriter
  readonly #availability?: Pick<RunEventAvailability, 'assertConversationWritable'>
  readonly #database: DatabaseSync
  readonly #onObserverError: (error: unknown) => void
  readonly #repository: TurnRequestRepository
  readonly #committed: Emitter<TurnRequestCommit>
  readonly onDidCommit: Emitter<TurnRequestCommit>['event']
  #disposed = false

  constructor(
    database: DatabaseSync,
    onObserverError: (error: unknown) => void = () => {},
    availability?: Pick<RunEventAvailability, 'assertConversationWritable'>,
    events?: SqliteRunEventWriter,
  ) {
    this.#availability = availability
    this.#events = events
    this.#database = database
    this.#repository = createTurnRequestRepository(database)
    this.#onObserverError = onObserverError
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  findByRequestId(requestId: string) {
    return this.#repository.findByRequestId(requestId)
  }

  prepare(input: PrepareTurnRequestInput | PrepareQuestionReplyInput) {
    return this.#commit(() => {
      this.#availability?.assertConversationWritable(input.conversationId)
      return this.#repository.prepare(input)
    })
  }

  edit(input: EditTurnRequestInput) {
    return this.#commit(() => {
      this.#availability?.assertConversationWritable(input.conversationId)
      return this.#repository.edit(input)
    })
  }

  regenerate(input: RegenerateTurnRequestInput) {
    return this.#commit(() => {
      this.#availability?.assertConversationWritable(input.conversationId)
      return this.#repository.regenerate(input)
    })
  }

  retryInterrupted(input: RetryInterruptedTurnRequestInput) {
    return this.#commit(() => {
      const request = this.#repository.findByRequestId(input.requestId)
      if (request)
        this.#availability?.assertConversationWritable(request.conversationId)
      return this.#repository.retryInterrupted(input)
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }

  #commit(operation: () => TurnRequestRecord): TurnRequestRecord {
    if (this.#disposed)
      throw new Error('Turn request service is stopped')
    return withTransaction(this.#database, () => {
      const request = operation()
      if (request.created && request.committedFacts?.length) {
        if (this.#events) {
          this.#database.prepare('UPDATE runs SET next_event_sequence = 1 WHERE id = ? AND next_event_sequence IS NULL').run(request.runId)
          this.#events.append({ runId: request.runId, type: 'run.queued', payload: { requestId: request.requestId, facts: request.committedFacts } })
        }
        const snapshot = copyEventSnapshot({ commitId: request.runId, requestId: request.requestId, runId: request.runId, conversationId: request.conversationId, branchId: request.branchId, facts: request.committedFacts })
        afterTransactionCommit(this.#database, () => this.#committed.fire(snapshot), this.#onObserverError)
      }
      return request
    })
  }
}
