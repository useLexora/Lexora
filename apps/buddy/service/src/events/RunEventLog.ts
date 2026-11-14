import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type {
  AppendBuddyRunEventInput,
  BuddyRunEvent,
  ListBuddyRunEventsOptions,
} from './BuddyRunEvent'
import type { RunEventMaintenanceOptions, RunEventMaintenanceSummary } from './RunEventMaintenanceService'
import type { RunEventLogPort } from './RunEventPorts'
import type { RunEventProjector } from './RunEventProjector'
import type { RunEventQueries } from './RunEventQueries'
import type { RunEventCheckpoint, RunEventRecoveryFailure, RunEventRecoveryOptions, RunEventRecoverySummary } from './RunEventRecovery'
import type { RunEventStore } from './RunEventStore'
import { performance } from 'node:perf_hooks'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import {
  buddyRunEventSchema,
  buddyRunIdSchema,
  isTerminalRunEventType,
} from './BuddyRunEvent'
import { prepareEventPayload } from './prepareEventPayload'
import { createRunEventCompactionPlan } from './RunEventCompaction'
import {
  RunEventCheckpointError,
  RunEventCorruptionError,
  RunEventLogFatalError,
  RunEventMaintenanceRetryableError,
  RunEventProjectionError,
} from './RunEventFailure'
import { RunEventMaintenanceService } from './RunEventMaintenanceService'
import { canCertifyBootstrapCheckpoint, canReuseRunEventCheckpoint, RUN_EVENT_PROJECTION_VERSION } from './RunEventRecovery'

export interface RunEventLogCallbacks {
  onObserverError?: (error: unknown) => void
  onFatalFailure?: (error: RunEventLogFatalError) => void
  onRecovery?: (summary: Readonly<RunEventRecoverySummary>) => void
  onMaintenance?: (summary: Readonly<RunEventMaintenanceSummary>) => void
  onRunQuarantined?: (failure: Readonly<RunEventRecoveryFailure>) => void
}

export type RunEventProjectorPort = Pick<
  RunEventProjector,
  'certifyBootstrapCheckpoint' | 'invalidateCheckpoint' | 'project' | 'rebuild' | 'removeEventRows' | 'validateNewFacts'
>

export type RunEventQueryPort = Pick<
  RunEventQueries,
  | 'findConversationId'
  | 'findLatest'
  | 'findRecoveryRun'
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
  | 'maintenanceRevision'
  | 'read'
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

export class RunEventPurgeInProgressError extends Error {
  readonly code = 'CONVERSATION_BUSY'

  constructor() {
    super('Task event history is being removed')
    this.name = 'RunEventPurgeInProgressError'
  }
}

export class RunEventLog implements RunEventLogPort {
  readonly #nextSequences = new Map<string, number>()
  readonly #maintenance: RunEventMaintenanceService
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
  readonly #purging = new Set<string>()
  #compactionTail: Promise<void> = Promise.resolve()
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
    this.#maintenance = new RunEventMaintenanceService({
      list: (after, limit) => this.#queries.listCompactableTerminalRunIds(after, limit),
      compact: runId => this.compactTerminalRun(runId),
      onSummary: options.onMaintenance,
      onFailure: (error) => {
        if (error instanceof RunEventCorruptionError || error instanceof RunEventMaintenanceRetryableError)
          return true
        try {
          this.#fail(error instanceof RunEventLogFatalError ? error : new RunEventCheckpointError('maintenance', { cause: error }))
        }
        catch {}
        return false
      },
    })
  }

  get state(): RunEventLogPort['state'] {
    return this.#closed ? 'closed' : this.#fatalFailure ? 'failed' : 'open'
  }

  getRecoveryFailures(): readonly Readonly<RunEventRecoveryFailure>[] {
    return Object.freeze([...this.#quarantined.values()].map(entry => entry.failure))
  }

  assertConversationWritable(_conversationId: string): void {
    this.#assertMutationAllowed()
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
      await this.#ensureProjection(runId)
      const nextSequence = this.#nextSequences.get(runId) ?? 1
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
      const revision = this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))
      await this.#runStoreOperation(() => this.#store.append(events))
      this.#nextSequences.set(runId, nextSequence + events.length)
      const fingerprint = await this.#fingerprint(runId)
      if (fingerprint === null)
        this.#quarantine(new RunEventCorruptionError(runId))
      if (revision !== this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))) {
        await this.#replay(runId)
      }
      else {
        await this.#projectCommitted(events, {
          fileFingerprint: fingerprint,
          lastSequence: nextSequence + events.length - 1,
          projectionVersion: RUN_EVENT_PROJECTION_VERSION,
        })
      }
      for (const event of committed)
        this.#committed.fire(event)
      this.#maintenance.wake()
      return events
    })
  }

  verifyRun(runId: string): Promise<void> {
    return this.#enqueue(runId, async () => {
      this.#assertRunAvailable(runId)
      await this.#ensureProjection(runId)
    })
  }

  read(runId: string): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, async () => {
      this.#assertRunAvailable(runId)
      if (this.#fatalFailure)
        return this.#readAndRepair(runId)
      await this.#ensureProjection(runId)
      return this.#queries.read(runId)
    })
  }

  findLatest(runId: string, eventTypes: readonly string[]): Promise<BuddyRunEvent | null> {
    const types = [...eventTypes]
    return this.#enqueue(runId, async () => {
      this.#assertRunAvailable(runId)
      await this.#ensureProjection(runId)
      return this.#queries.findLatest(runId, types)
    })
  }

  list(runId: string, options: ListBuddyRunEventsOptions = {}): Promise<BuddyRunEvent[]> {
    return this.#enqueue(runId, async () => {
      this.#assertRunAvailable(runId)
      await this.#ensureProjection(runId)
      return this.#queries.list(runId, options)
    })
  }

  listForConversation(
    conversationId: string,
    options: Pick<ListBuddyRunEventsOptions, 'limit'> = {},
  ): BuddyRunEvent[] {
    this.#assertOpen()
    return this.#queries.listForConversation(conversationId, { ...options, excludedRunIds: [...this.#quarantined.keys()] })
  }

  listForRuns(runIds: readonly string[], options?: { latestActivityOnly?: boolean }): BuddyRunEvent[] {
    this.#assertOpen()
    return this.#queries.listForRuns(runIds.filter(runId => !this.#quarantined.has(runId)), options)
  }

  listToolCounts(runIds: readonly string[]): ReadonlyMap<string, number> {
    this.#assertOpen()
    return this.#queries.listToolCounts(runIds)
  }

  replay(runId: string): Promise<number> {
    return this.#enqueue(runId, () => this.#replay(runId))
  }

  async recoverAll(options: RunEventRecoveryOptions = {}): Promise<Readonly<RunEventRecoverySummary>> {
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
    let completed = 0
    let total: number | undefined
    let reportedCompleted = -1
    let lastProgressAt = started
    const reportProgress = (force = false) => {
      if (!options.onProgress || total === undefined || completed === reportedCompleted)
        return
      const now = performance.now()
      if (!force && now - lastProgressAt < 250)
        return
      reportedCompleted = completed
      lastProgressAt = now
      try {
        options.onProgress(Object.freeze({ completed, total }))
      }
      catch {}
    }
    try {
      const enumerationStarted = performance.now()
      const runs = this.#databaseOperation('recovery', () => this.#queries.listRecoveryRuns(options))
      total = runs.length
      reportProgress(true)
      if (options.force) {
        await this.#runStoreOperation(() => this.#store.listPersistedRunIds(
          runs.map(run => run.runId),
          new Map(runs.map(run => [run.runId, run.conversationId])),
        ))
      }
      summary.enumerationMs = performance.now() - enumerationStarted
      for (const run of runs) {
        try {
          await this.#enqueue(run.runId, async () => {
            summary.scanned++
            const fingerprint = await this.#fingerprint(run.runId, run.conversationId, summary)
            if (this.#reuseEmptyRun(run.runId, fingerprint, run.checkpoint)) {
              summary.skipped++
              return
            }
            if (!options.force && canCertifyBootstrapCheckpoint(run, fingerprint)
              && this.#databaseOperation(run.runId, () => this.#projector.certifyBootstrapCheckpoint(run))) {
              this.#nextSequences.set(run.runId, run.checkpoint.lastSequence + 1)
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
        completed++
        reportProgress()
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
      reportProgress(true)
      summary.durationMs = performance.now() - started
      summary.failures = this.getRecoveryFailures()
      try {
        this.#onRecovery?.(Object.freeze({ ...summary }))
      }
      catch {}
    }
  }

  async withConversationPurge<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    this.#assertMutationAllowed()
    const runIds = this.#queries.listRunIds(conversationId)
    if (runIds.some(id => this.#purging.has(id)))
      throw new RunEventPurgeInProgressError()
    for (const id of runIds)
      this.#purging.add(id)
    try {
      await Promise.all(runIds.map(id => this.#tails.get(id)))
      const result = await operation()
      for (const id of runIds) {
        this.#nextSequences.delete(id)
        this.#quarantined.delete(id)
      }
      return result
    }
    finally {
      for (const id of runIds)
        this.#purging.delete(id)
    }
  }

  compactTerminalRun(runId: string): Promise<number> {
    const result = this.#compactionTail.then(() => this.#purging.has(runId) ? 0 : this.#enqueueMutation(runId, () => this.#compactTerminalRun(runId)))
    this.#compactionTail = result.then(() => undefined, () => undefined)
    return result
  }

  async compactTerminalRuns(): Promise<number> {
    this.#assertMutationAllowed()
    let removed = 0
    let cursor = ''
    while (true) {
      const candidates = this.#databaseOperation('maintenance', () => this.#queries.listCompactableTerminalRunIds(cursor))
      if (!candidates.length)
        break
      for (const runId of candidates) {
        cursor = runId
        try {
          removed += await this.compactTerminalRun(runId)
        }
        catch (error) {
          if (!(error instanceof RunEventCorruptionError))
            throw error
        }
      }
    }
    return removed
  }

  startMaintenance(options: RunEventMaintenanceOptions = {}): void {
    this.#assertMutationAllowed()
    this.#maintenance.start(options)
  }

  stopMaintenance(): Promise<void> {
    return this.#maintenance.stop()
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
    this.#closePromise = Promise.all([this.stopMaintenance(), this.#compactionTail, ...this.#tails.values()]).then(() => {
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
    this.#invalidateCheckpoint(runId)
    const before = knownFingerprint === undefined ? await this.#fingerprint(runId, conversationId, summary) : knownFingerprint
    const readStarted = performance.now()
    const events = await this.#readAndRepair(runId, conversationId)
    if (summary)
      summary.readMs += performance.now() - readStarted
    const after = await this.#fingerprint(runId, conversationId, summary)
    const quarantined = this.#quarantined.get(runId)
    if (quarantined && (events.length === 0 || after === null || before !== after))
      throw quarantined.error
    // Repairs or concurrent external changes are not certified by this read.
    const checkpoint = after !== null && before === after
      ? { fileFingerprint: after, lastSequence: nextEventSequence(events) - 1, projectionVersion: RUN_EVENT_PROJECTION_VERSION }
      : before === null && after === null ? null : undefined
    const projectionStarted = performance.now()
    const count = this.#rebuildProjection(runId, events, checkpoint)
    this.#nextSequences.set(runId, nextEventSequence(events))
    this.#quarantined.delete(runId)
    if (summary)
      summary.projectionMs += performance.now() - projectionStarted
    return count
  }

  async #ensureProjection(runId: string): Promise<void> {
    const run = this.#databaseOperation(runId, () => this.#queries.findRecoveryRun(runId))
    if (!run)
      return
    const fingerprint = await this.#fingerprint(runId, run.conversationId)
    if (this.#reuseEmptyRun(runId, fingerprint, run.checkpoint))
      return
    if (canReuseRunEventCheckpoint(run, fingerprint)
      && this.#databaseOperation(runId, () => this.#queries.hasCheckpoint(runId, run.checkpoint))) {
      this.#nextSequences.set(runId, run.checkpoint.lastSequence + 1)
      return
    }
    await this.#replay(runId, run.conversationId, undefined, fingerprint)
  }

  #reuseEmptyRun(runId: string, fingerprint: string | null, checkpoint: RunEventCheckpoint | null): boolean {
    if (fingerprint !== null)
      return false
    if ((checkpoint?.lastSequence ?? 0) > 0 || this.#databaseOperation(runId, () => this.#queries.hasProjectedEvents(runId)))
      this.#quarantine(new RunEventCorruptionError(runId))
    this.#assertRunAvailable(runId)
    this.#invalidateCheckpoint(runId)
    this.#databaseOperation(runId, () => this.#projector.removeEventRows(runId, [], null))
    this.#nextSequences.set(runId, 1)
    return true
  }

  #databaseOperation<T>(runId: string, operation: () => T): T {
    try {
      return operation()
    }
    catch (cause) {
      this.#fail(new RunEventCheckpointError(runId, { cause }))
    }
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
    await this.#ensureProjection(runId)
    if (!this.#isTerminalRun(runId))
      return 0
    const revision = this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))
    const before = await this.#fingerprint(runId)
    const events = await this.#readAndRepair(runId)
    if (before !== await this.#fingerprint(runId))
      return 0
    if (revision !== this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))) {
      await this.#replay(runId)
      return 0
    }
    if (before === null) {
      this.#databaseOperation(runId, () => this.#projector.removeEventRows(runId, [], null))
      return 0
    }
    const { removed, retained } = events.some(event => isTerminalRunEventType(event.type))
      ? createRunEventCompactionPlan(events)
      : { removed: [], retained: events }
    let replacementRevision = revision
    if (removed.length) {
      this.#invalidateCheckpoint(runId)
      replacementRevision = this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))
      await this.#runStoreOperation(() => this.#store.replace(runId, retained, events))
    }
    const fingerprint = await this.#fingerprint(runId)
    if (fingerprint === null)
      this.#quarantine(new RunEventCorruptionError(runId))
    if (replacementRevision !== this.#databaseOperation(runId, () => this.#queries.maintenanceRevision(runId))) {
      await this.#replay(runId)
      return removed.length
    }
    try {
      this.#projector.removeEventRows(runId, removed.map(event => event.sequence), {
        fileFingerprint: fingerprint,
        lastSequence: nextEventSequence(retained) - 1,
        projectionVersion: RUN_EVENT_PROJECTION_VERSION,
      })
    }
    catch (cause) {
      this.#fail(new RunEventProjectionError(runId, retained, { cause }))
    }
    this.#nextSequences.set(runId, nextEventSequence(retained))
    return removed.length
  }

  async #projectCommitted(events: readonly BuddyRunEvent[], checkpoint: RunEventCheckpoint): Promise<void> {
    try {
      this.#projector.project(events, checkpoint)
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

  #rebuildProjection(runId: string, events: readonly BuddyRunEvent[], checkpoint?: RunEventCheckpoint | null): number {
    try {
      return this.#projector.rebuild(runId, events, checkpoint)
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
    try {
      this.#projector.invalidateCheckpoint(runId)
    }
    catch (cause) {
      this.#fail(new RunEventCheckpointError(runId, { cause }))
    }
  }

  async #readAndRepair(runId: string, conversationId?: string): Promise<BuddyRunEvent[]> {
    const events = await this.#runStoreOperation(() => this.#store.readAndRepair(runId, conversationId, () => this.#invalidateCheckpoint(runId)))
    if (!events.length && this.#databaseOperation(runId, () => this.#queries.hasProjectedEvents(runId)))
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
    this.#invalidateCheckpoint(error.runId)
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

  #assertRunAvailable(runId: string): void {
    const entry = this.#quarantined.get(runId)
    if (entry)
      throw entry.error
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
    if (this.#purging.has(runId))
      return Promise.reject(new RunEventPurgeInProgressError())
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
