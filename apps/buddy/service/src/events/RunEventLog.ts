import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type {
  AppendBuddyRunEventInput,
  BuddyRunEvent,
  ListBuddyRunEventsOptions,
} from './BuddyRunEvent'
import type { RunEventLogPort } from './RunEventPorts'
import type { RunEventProjector } from './RunEventProjector'
import type { RunEventQueries } from './RunEventQueries'
import type { RunEventStore } from './RunEventStore'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import {
  buddyRunEventSchema,
  buddyRunIdSchema,
  isTerminalRunEventType,
} from './BuddyRunEvent'
import { createRunEventCompactionPlan } from './RunEventCompaction'
import {
  RunEventLogFatalError,
  RunEventProjectionError,
} from './RunEventFailure'

export interface RunEventLogCallbacks {
  onObserverError?: (error: unknown) => void
  onFatalFailure?: (error: RunEventLogFatalError) => void
}

export type RunEventProjectorPort = Pick<
  RunEventProjector,
  'project' | 'rebuild' | 'removeEventRows' | 'validateNewFacts'
>

export type RunEventQueryPort = Pick<
  RunEventQueries,
  | 'isTerminalRun'
  | 'list'
  | 'listCompactableTerminalRunIds'
  | 'listForConversation'
  | 'listForRuns'
  | 'listRunIds'
>

export type RunEventStorePort = Pick<
  RunEventStore,
  'append' | 'listPersistedRunIds' | 'readAndRepair' | 'replace'
>

export interface RunEventLogOptions extends RunEventLogCallbacks {
  projector: RunEventProjectorPort
  queries: RunEventQueryPort
  store: RunEventStorePort
}

export class RunEventLogClosedError extends Error {
  constructor() {
    super('Lexora Buddy run event log is closed')
    this.name = 'RunEventLogClosedError'
  }
}

export class RunEventLog implements RunEventLogPort {
  readonly #nextSequences = new Map<string, number>()
  readonly #committed: Emitter<EventSnapshot<BuddyRunEvent>>
  readonly onDidCommit: RunEventLogPort['onDidCommit']
  readonly #onFatalFailure?: (error: RunEventLogFatalError) => void
  readonly #projector: RunEventProjectorPort
  readonly #queries: RunEventQueryPort
  readonly #store: RunEventStorePort
  readonly #tails = new Map<string, Promise<void>>()
  #closePromise: Promise<void> | null = null
  #closed = false
  #fatalFailure: RunEventLogFatalError | null = null

  constructor(options: RunEventLogOptions) {
    this.#committed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCommit = this.#committed.event
    this.#onFatalFailure = options.onFatalFailure
    this.#projector = options.projector
    this.#queries = options.queries
    this.#store = options.store
  }

  get state(): RunEventLogPort['state'] {
    return this.#closed ? 'closed' : this.#fatalFailure ? 'failed' : 'open'
  }

  append(input: AppendBuddyRunEventInput): Promise<BuddyRunEvent> {
    return this.appendBatch([input]).then(events => events[0]!)
  }

  appendBatch(inputs: readonly AppendBuddyRunEventInput[]): Promise<BuddyRunEvent[]> {
    try {
      this.#assertMutationAllowed()
    }
    catch (error) {
      return Promise.reject(error)
    }
    if (inputs.length === 0)
      return Promise.resolve([])
    const runId = inputs[0]!.runId
    if (inputs.some(input => input.runId !== runId))
      return Promise.reject(new Error('Lexora Buddy event batch must belong to one run'))
    return this.#enqueueMutation(runId, async () => {
      let nextSequence = this.#nextSequences.get(runId)
      if (nextSequence === undefined) {
        const existing = await this.#readAndRepair(runId)
        nextSequence = nextEventSequence(existing)
      }
      const events = inputs.map((input, index) => buddyRunEventSchema.parse(JSON.parse(JSON.stringify({
        runId,
        sequence: nextSequence + index,
        type: input.type,
        payload: input.payload ?? null,
        createdAt: input.createdAt ?? new Date().toISOString(),
      }))))
      const committed = events.map(event => copyEventSnapshot(event))
      this.#projector.validateNewFacts(events)
      await this.#runStoreOperation(() => this.#store.append(events))
      this.#nextSequences.set(runId, nextSequence + events.length)
      await this.#projectCommitted(events)
      for (const event of committed)
        this.#committed.fire(event)
      return events
    })
  }

  read(runId: string): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, () => this.#readAndRepair(runId))
  }

  list(runId: string, options: ListBuddyRunEventsOptions = {}): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, async () => this.#queries.list(runId, options))
  }

  listForConversation(
    conversationId: string,
    options: Pick<ListBuddyRunEventsOptions, 'limit'> = {},
  ): BuddyRunEvent[] {
    this.#assertOpen()
    return this.#queries.listForConversation(conversationId, options)
  }

  listForRuns(runIds: readonly string[]): BuddyRunEvent[] {
    this.#assertOpen()
    return this.#queries.listForRuns(runIds)
  }

  replay(runId: string): Promise<number> {
    return this.#enqueue(runId, async () => {
      const events = await this.#readAndRepair(runId)
      this.#nextSequences.set(runId, nextEventSequence(events))
      return this.#rebuildProjection(runId, events)
    })
  }

  compactTerminalRun(runId: string): Promise<number> {
    return this.#enqueueMutation(runId, () => this.#compactTerminalRun(runId))
  }

  async compactTerminalRuns(): Promise<number> {
    this.#assertMutationAllowed()
    let removed = 0
    for (const runId of this.#queries.listCompactableTerminalRunIds())
      removed += await this.compactTerminalRun(runId)
    return removed
  }

  async replayAll(): Promise<number> {
    this.#assertOpen()
    let replayed = 0
    const persistedRunIds = await this.#runStoreOperation(() => (
      this.#store.listPersistedRunIds(this.#queries.listRunIds())
    ))
    for (const runId of persistedRunIds)
      replayed += await this.replay(runId)
    return replayed
  }

  close(): Promise<void> {
    if (this.#closePromise)
      return this.#closePromise
    this.#closed = true
    this.#closePromise = Promise.all(this.#tails.values()).then(() => this.#committed.dispose())
    return this.#closePromise
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new RunEventLogClosedError()
  }

  #assertMutationAllowed(): void {
    this.#assertOpen()
    this.#assertNoFatalFailure()
  }

  #assertNoFatalFailure(): void {
    if (this.#fatalFailure)
      throw this.#fatalFailure
  }

  async #compactTerminalRun(runId: string): Promise<number> {
    if (!this.#isTerminalRun(runId))
      return 0
    const events = await this.#readAndRepair(runId)
    if (!events.some(event => isTerminalRunEventType(event.type)))
      return 0
    const { removed, retained } = createRunEventCompactionPlan(events)
    if (removed.length === 0)
      return 0
    await this.#runStoreOperation(() => this.#store.replace(runId, retained, events))
    try {
      this.#projector.removeEventRows(runId, removed.map(event => event.sequence))
    }
    catch {
      this.#rebuildProjection(runId, retained)
    }
    this.#nextSequences.set(runId, nextEventSequence(retained))
    return removed.length
  }

  async #projectCommitted(events: readonly BuddyRunEvent[]): Promise<void> {
    try {
      this.#projector.project(events)
      return
    }
    catch {}

    try {
      const runId = events[0]!.runId
      const durableEvents = await this.#readAndRepair(runId)
      this.#rebuildProjection(runId, durableEvents)
      this.#nextSequences.set(runId, nextEventSequence(durableEvents))
    }
    catch (cause) {
      if (cause instanceof RunEventLogFatalError)
        throw cause
      const error = new RunEventProjectionError(events[0]!.runId, events, { cause })
      this.#fail(error)
    }
  }

  #rebuildProjection(runId: string, events: readonly BuddyRunEvent[]): number {
    try {
      return this.#projector.rebuild(runId, events)
    }
    catch (cause) {
      this.#fail(new RunEventProjectionError(runId, events, { cause }))
    }
  }

  #fail(error: RunEventLogFatalError): never {
    if (!this.#fatalFailure) {
      this.#fatalFailure = error
      try {
        this.#onFatalFailure?.(error)
      }
      catch {}
    }
    throw this.#fatalFailure
  }

  async #readAndRepair(runId: string): Promise<BuddyRunEvent[]> {
    return this.#runStoreOperation(() => this.#store.readAndRepair(runId))
  }

  async #runStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    }
    catch (error) {
      if (error instanceof RunEventLogFatalError)
        this.#fail(error)
      throw error
    }
  }

  #isTerminalRun(runId: string): boolean {
    return this.#queries.isTerminalRun(runId)
  }

  #enqueueMutation<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.#assertMutationAllowed()
    }
    catch (error) {
      return Promise.reject(error)
    }
    return this.#enqueue(runId, () => {
      this.#assertNoFatalFailure()
      return operation()
    })
  }

  #enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(new RunEventLogClosedError())
    buddyRunIdSchema.parse(runId)
    const previous = this.#tails.get(runId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.#tails.set(runId, tail)
    void tail.finally(() => {
      if (this.#tails.get(runId) === tail)
        this.#tails.delete(runId)
    })
    return result
  }
}

function nextEventSequence(events: readonly BuddyRunEvent[]): number {
  return (events.at(-1)?.sequence ?? 0) + 1
}
