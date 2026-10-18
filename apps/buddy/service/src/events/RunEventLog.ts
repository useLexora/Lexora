import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type {
  AppendBuddyRunEventInput,
  BuddyRunEvent,
  ListBuddyRunEventsOptions,
} from './BuddyRunEvent'
import type { RunEventLogPort } from './RunEventPorts'
import type { RunEventProjector } from './RunEventProjector'
import type { RunEventQueries } from './RunEventQueries'
import type { RunEventCheckpoint, RunEventRecoveryFailure, RunEventRecoverySummary } from './RunEventRecovery'
import type { RunEventStore } from './RunEventStore'
import { performance } from 'node:perf_hooks'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { executionMailboxDraftSchema, executionMailboxMessageSchema } from '../../../shared/executions/executionApi'
import { hashExecutionMailboxMessage } from '../storage/mailboxRepository'
import {
  buddyRunEventSchema,
  buddyRunIdSchema,
  isTerminalRunEventType,
} from './BuddyRunEvent'
import { createRunEventCompactionPlan } from './RunEventCompaction'
import {
  RunEventCheckpointError,
  RunEventCorruptionError,
  RunEventLogFatalError,
  RunEventProjectionError,
} from './RunEventFailure'
import { canReuseRunEventCheckpoint, RUN_EVENT_PROJECTION_VERSION } from './RunEventRecovery'

export interface RunEventLogCallbacks {
  onObserverError?: (error: unknown) => void
  onFatalFailure?: (error: RunEventLogFatalError) => void
  onRecovery?: (summary: Readonly<RunEventRecoverySummary>) => void
  onRunQuarantined?: (failure: Readonly<RunEventRecoveryFailure>) => void
}

export type RunEventProjectorPort = Pick<
  RunEventProjector,
  'invalidateCheckpoint' | 'project' | 'rebuild' | 'removeEventRows' | 'validateNewFacts'
>

export type RunEventQueryPort = Pick<
  RunEventQueries,
  | 'findConversationId'
  | 'hasCheckpoint'
  | 'hasProjectedEvents'
  | 'isTerminalRun'
  | 'list'
  | 'listRecoveryRuns'
  | 'listCompactableTerminalRunIds'
  | 'listForConversation'
  | 'listForRuns'
  | 'listToolCounts'
  | 'listRunIds'
>

export type RunEventStorePort = Pick<
  RunEventStore,
  'append' | 'fingerprint' | 'listPersistedRunIds' | 'readAndRepair' | 'replace'
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
  readonly #compactionCheckedRuns = new Map<string, RunEventCheckpoint>()
  readonly #committed: Emitter<EventSnapshot<BuddyRunEvent>>
  readonly onDidCommit: RunEventLogPort['onDidCommit']
  readonly #quarantineChanges: Emitter<Readonly<RunEventRecoveryFailure>>
  readonly onDidQuarantine: RunEventLogPort['onDidQuarantine']
  readonly #onFatalFailure?: (error: RunEventLogFatalError) => void
  readonly #onRecovery?: RunEventLogCallbacks['onRecovery']
  readonly #onRunQuarantined?: RunEventLogCallbacks['onRunQuarantined']
  readonly #quarantined = new Map<string, { error: RunEventCorruptionError, failure: Readonly<RunEventRecoveryFailure> }>()
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
    this.#quarantineChanges = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidQuarantine = this.#quarantineChanges.event
    this.#onFatalFailure = options.onFatalFailure
    this.#onRecovery = options.onRecovery
    this.#onRunQuarantined = options.onRunQuarantined
    this.#projector = options.projector
    this.#queries = options.queries
    this.#store = options.store
  }

  get state(): RunEventLogPort['state'] {
    return this.#closed ? 'closed' : this.#fatalFailure ? 'failed' : 'open'
  }

  getRecoveryFailures(): readonly Readonly<RunEventRecoveryFailure>[] {
    return Object.freeze([...this.#quarantined.values()].map(entry => entry.failure))
  }

  assertConversationWritable(conversationId: string): void {
    this.#assertMutationAllowed()
    this.#assertConversationAvailable(conversationId)
  }

  assertRunExecutable(runId: string): void {
    this.assertRunWritable(runId)
  }

  assertRunWritable(runId: string): void {
    this.#assertMutationAllowed()
    this.#assertRunAvailable(runId)
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
        payload: prepareEventPayload(input, nextSequence + index),
        createdAt: input.createdAt ?? new Date().toISOString(),
      }))))
      const committed = events.map(event => copyEventSnapshot(event))
      this.#assertNoFatalFailure()
      this.#assertRunAvailable(runId)
      this.#projector.validateNewFacts(events)
      this.#invalidateCheckpoint(runId)
      await this.#runStoreOperation(() => this.#store.append(events))
      this.#nextSequences.set(runId, nextSequence + events.length)
      await this.#projectCommitted(events)
      for (const event of committed)
        this.#committed.fire(event)
      return events
    })
  }

  read(runId: string): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, () => {
      this.#assertRunAvailable(runId)
      return this.#readAndRepair(runId)
    })
  }

  list(runId: string, options: ListBuddyRunEventsOptions = {}): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, async () => {
      this.#assertRunAvailable(runId)
      return this.#queries.list(runId, options)
    })
  }

  listForConversation(
    conversationId: string,
    options: Pick<ListBuddyRunEventsOptions, 'limit'> = {},
  ): BuddyRunEvent[] {
    this.#assertOpen()
    this.#assertConversationAvailable(conversationId)
    return this.#queries.listForConversation(conversationId, options)
  }

  listForRuns(runIds: readonly string[], options?: { latestActivityOnly?: boolean }): BuddyRunEvent[] {
    this.#assertOpen()
    for (const runId of runIds)
      this.#assertRunAvailable(runId)
    return this.#queries.listForRuns(runIds, options)
  }

  listToolCounts(runIds: readonly string[]): ReadonlyMap<string, number> {
    this.#assertOpen()
    for (const runId of runIds)
      this.#assertRunAvailable(runId)
    return this.#queries.listToolCounts(runIds)
  }

  replay(runId: string): Promise<number> {
    return this.#enqueue(runId, () => this.#replay(runId))
  }

  async recoverAll(options: { force?: boolean } = {}): Promise<Readonly<RunEventRecoverySummary>> {
    this.#assertOpen()
    const started = performance.now()
    const summary: RunEventRecoverySummary = {
      durationMs: 0,
      enumerationMs: 0,
      inspectionMs: 0,
      readMs: 0,
      projectionMs: 0,
      scanned: 0,
      skipped: 0,
      rebuilt: 0,
      events: 0,
      failed: 0,
      failures: [],
    }
    try {
      const enumerationStarted = performance.now()
      const runs = this.#queries.listRecoveryRuns()
      const conversations = new Map(runs.map(run => [run.runId, run.conversationId]))
      const persisted = new Set(await this.#runStoreOperation(() => (
        this.#store.listPersistedRunIds(runs.map(run => run.runId), conversations)
      )))
      summary.enumerationMs = performance.now() - enumerationStarted
      for (const run of runs) {
        try {
          if (!persisted.has(run.runId)) {
            await this.#enqueue(run.runId, async () => {
              this.#invalidateCheckpoint(run.runId)
              if (run.projectedLastSequence > 0)
                this.#quarantine(new RunEventCorruptionError(run.runId))
            })
            continue
          }
          await this.#enqueue(run.runId, async () => {
            summary.scanned++
            const fingerprint = await this.#fingerprint(run.runId, run.conversationId, summary)
            if (!options.force && !this.#fatalFailure && !this.#quarantined.has(run.runId) && canReuseRunEventCheckpoint(run, fingerprint)
              && this.#queries.hasCheckpoint(run.runId, run.checkpoint)) {
              this.#nextSequences.set(run.runId, run.checkpoint.lastSequence + 1)
              this.#compactionCheckedRuns.set(run.runId, run.checkpoint)
              summary.skipped++
              return
            }
            summary.events += await this.#replay(run.runId, run.conversationId, summary, fingerprint)
            summary.rebuilt++
          })
        }
        catch (error) {
          if (!(error instanceof RunEventCorruptionError))
            throw error
          summary.failed++
        }
      }
      summary.failures = this.getRecoveryFailures()
      summary.failed = Math.max(summary.failed, summary.failures.length)
      return Object.freeze({ ...summary, durationMs: performance.now() - started })
    }
    catch (error) {
      summary.failed++
      throw error
    }
    finally {
      summary.durationMs = performance.now() - started
      summary.failures = this.getRecoveryFailures()
      try {
        this.#onRecovery?.(Object.freeze({ ...summary }))
      }
      catch {}
    }
  }

  compactTerminalRun(runId: string): Promise<number> {
    return this.#enqueueMutation(runId, () => this.#compactTerminalRun(runId))
  }

  async compactTerminalRuns(): Promise<number> {
    this.#assertMutationAllowed()
    let removed = 0
    for (const runId of this.#queries.listCompactableTerminalRunIds()) {
      try {
        removed += await this.#enqueueMutation(runId, async () => {
          const checked = this.#compactionCheckedRuns.get(runId)
          if (checked && this.#queries.hasCheckpoint(runId, checked)
            && await this.#fingerprint(runId) === checked.fileFingerprint) {
            return 0
          }
          return this.#compactTerminalRun(runId)
        })
      }
      catch (error) {
        if (!(error instanceof RunEventCorruptionError))
          throw error
      }
    }
    return removed
  }

  async replayAll(): Promise<number> {
    const summary = await this.recoverAll({ force: true })
    const failure = this.#quarantined.values().next().value
    if (failure)
      throw failure.error
    return summary.events
  }

  close(): Promise<void> {
    if (this.#closePromise)
      return this.#closePromise
    this.#closed = true
    this.#closePromise = Promise.all(this.#tails.values()).then(() => {
      this.#committed.dispose()
      this.#quarantineChanges.dispose()
    })
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

  async #replay(
    runId: string,
    conversationId?: string,
    summary?: RunEventRecoverySummary,
    knownFingerprint?: string | null,
  ): Promise<number> {
    const before = knownFingerprint === undefined ? await this.#fingerprint(runId, conversationId, summary) : knownFingerprint
    const readStarted = performance.now()
    const events = await this.#readAndRepair(runId, conversationId)
    const compacted = createRunEventCompactionPlan(events).removed.length === 0
    if (summary)
      summary.readMs += performance.now() - readStarted
    const after = await this.#fingerprint(runId, conversationId, summary)
    const quarantined = this.#quarantined.get(runId)
    if (quarantined && (events.length === 0 || after === null || before !== after))
      throw quarantined.error
    // Repairs or concurrent external changes are not certified by this read.
    const checkpoint = after !== null && before === after && compacted
      ? { fileFingerprint: after, lastSequence: nextEventSequence(events) - 1, projectionVersion: RUN_EVENT_PROJECTION_VERSION }
      : undefined
    const projectionStarted = performance.now()
    const count = this.#rebuildProjection(runId, events, checkpoint)
    this.#nextSequences.set(runId, nextEventSequence(events))
    this.#quarantined.delete(runId)
    if (summary)
      summary.projectionMs += performance.now() - projectionStarted
    return count
  }

  async #fingerprint(runId: string, conversationId?: string, summary?: RunEventRecoverySummary): Promise<string | null> {
    const started = performance.now()
    try {
      return await this.#runStoreOperation(() => this.#store.fingerprint(runId, conversationId))
    }
    finally {
      if (summary)
        summary.inspectionMs += performance.now() - started
    }
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
      // A projection write already failed; a corrupt fallback read cannot narrow its scope.
      const error = new RunEventProjectionError(events[0]!.runId, events, { cause })
      this.#fail(error)
    }
  }

  #rebuildProjection(runId: string, events: readonly BuddyRunEvent[], checkpoint?: RunEventCheckpoint): number {
    try {
      const count = this.#projector.rebuild(runId, events, checkpoint)
      if (checkpoint && this.#queries.hasCheckpoint(runId, checkpoint))
        this.#compactionCheckedRuns.set(runId, checkpoint)
      return count
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

  #invalidateCheckpoint(runId: string): void {
    this.#compactionCheckedRuns.delete(runId)
    try {
      this.#projector.invalidateCheckpoint(runId)
    }
    catch (cause) {
      this.#fail(new RunEventCheckpointError(runId, { cause }))
    }
  }

  async #readAndRepair(runId: string, conversationId?: string): Promise<BuddyRunEvent[]> {
    this.#invalidateCheckpoint(runId)
    const events = await this.#runStoreOperation(() => this.#store.readAndRepair(runId, conversationId))
    if (!events.length && this.#queries.hasProjectedEvents(runId))
      this.#quarantine(new RunEventCorruptionError(runId))
    return events
  }

  async #runStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    }
    catch (error) {
      if (error instanceof RunEventCorruptionError)
        this.#quarantine(error)
      if (error instanceof RunEventLogFatalError)
        this.#fail(error)
      throw error
    }
  }

  #quarantine(error: RunEventCorruptionError): never {
    this.#nextSequences.delete(error.runId)
    this.#compactionCheckedRuns.delete(error.runId)
    let entry = this.#quarantined.get(error.runId)
    if (!entry) {
      const failure = Object.freeze({
        code: error.code,
        conversationId: this.#queries.findConversationId(error.runId),
        runId: error.runId,
      })
      entry = { error, failure }
      this.#quarantined.set(error.runId, entry)
      this.#quarantineChanges.fire(failure)
      try {
        this.#onRunQuarantined?.(failure)
      }
      catch {}
    }
    throw entry.error
  }

  #assertConversationAvailable(conversationId: string): void {
    for (const entry of this.#quarantined.values()) {
      if (entry.failure.conversationId === conversationId)
        throw entry.error
    }
  }

  #assertRunAvailable(runId: string): void {
    const entry = this.#quarantined.get(runId)
    if (entry)
      throw entry.error
    if (!this.#quarantined.size)
      return
    const conversationId = this.#queries.findConversationId(runId)
    if (conversationId)
      this.#assertConversationAvailable(conversationId)
  }

  #isTerminalRun(runId: string): boolean {
    return this.#queries.isTerminalRun(runId)
  }

  #enqueueMutation<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.assertRunWritable(runId)
    }
    catch (error) {
      return Promise.reject(error)
    }
    return this.#enqueue(runId, () => {
      this.#assertNoFatalFailure()
      this.#assertRunAvailable(runId)
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

export function prepareEventPayload(input: AppendBuddyRunEventInput, sequence: number): unknown {
  if (input.type !== 'execution.mailbox.sent')
    return input.payload ?? null
  const draft = executionMailboxDraftSchema.parse(input.payload)
  const message = { ...draft, sourceRunId: input.runId, sourceSequence: sequence }
  return executionMailboxMessageSchema.parse({ ...message, payloadHash: hashExecutionMailboxMessage(message) })
}
