import type { DatabaseSync } from 'node:sqlite'
import type { AppendBuddyRunEventInput, BuddyRunEvent, ListBuddyRunEventsOptions } from './BuddyRunEvent'
import type { RunEventMaintenanceOptions } from './RunEventMaintenanceService'
import type { RunEventLogPort } from './RunEventPorts'
import type { RunEventRecoveryFailure, RunEventRecoveryOptions, RunEventRecoverySummary } from './RunEventRecovery'
import { performance } from 'node:perf_hooks'
import { Emitter } from '../../../shared/events/Emitter'
import { checkpointSqliteStorage } from '../storage/checkpointSqliteStorage'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { getStorageIsolation } from '../storage/StorageIsolation'
import { assertCommittedRead } from '../storage/transaction'
import { buddyRunIdSchema } from './BuddyRunEvent'
import { RunEventDatabaseError } from './RunEventFailure'
import { RunEventMaintenanceService } from './RunEventMaintenanceService'
import { RunEventQueries } from './RunEventQueries'
import { SqliteRunEventWriter } from './SqliteRunEventWriter'

export interface SqliteRunEventLogOptions {
  database: DatabaseSync
  onObserverError?: (error: unknown) => void
  onFatalFailure?: (error: RunEventDatabaseError) => void
}

export class SqliteRunEventLog implements RunEventLogPort {
  readonly #database: DatabaseSync
  readonly #queries: RunEventQueries
  readonly #writer: SqliteRunEventWriter
  readonly #maintenance: RunEventMaintenanceService
  readonly #quarantineChanges = new Emitter<Readonly<RunEventRecoveryFailure>>(() => {})
  readonly #onFatalFailure?: SqliteRunEventLogOptions['onFatalFailure']
  readonly onDidCommit: RunEventLogPort['onDidCommit']
  readonly onDidQuarantine = this.#quarantineChanges.event
  #closed = false
  #closePromise: Promise<void> | undefined
  #failure: RunEventDatabaseError | null = null

  constructor(options: SqliteRunEventLogOptions) {
    assertCommittedRead(options.database)
    requireSqliteAuthority(options.database)
    this.#database = options.database
    this.#queries = new RunEventQueries(options.database, 'run_sequence')
    this.#writer = new SqliteRunEventWriter(options.database, options.onObserverError)
    this.#onFatalFailure = options.onFatalFailure
    this.onDidCommit = this.#writer.onDidCommit
    this.#maintenance = new RunEventMaintenanceService({
      list: (after, limit) => this.#execute('', 'read', () => this.#queries.listCompactableTerminalRunIds(after, limit)),
      compact: runId => this.compactTerminalRun(runId),
      onFailure: () => false,
    })
    this.onDidCommit(() => this.#maintenance.wake())
  }

  get transactionWriter(): SqliteRunEventWriter {
    return this.#writer
  }

  get state(): RunEventLogPort['state'] {
    return this.#closed ? 'closed' : this.#failure || getStorageIsolation(this.#database).failure ? 'failed' : 'open'
  }

  assertConversationWritable(_conversationId: string): void {
    this.#execute('', 'read', () => {}, false)
  }

  assertRunWritable(runId: string): void {
    this.#execute(runId, 'read', () => this.#assertSequences([runId]), false)
  }

  assertRunExecutable(runId: string): void {
    this.assertRunWritable(runId)
  }

  getRecoveryFailures(): readonly Readonly<RunEventRecoveryFailure>[] {
    return []
  }

  async verifyRun(runId: string): Promise<void> {
    await this.read(runId)
  }

  async findLatest(runId: string, eventTypes: readonly string[]): Promise<BuddyRunEvent | null> {
    buddyRunIdSchema.parse(runId)
    return this.#execute(runId, 'read', () => {
      this.#assertSequences([runId])
      return this.#queries.findLatest(runId, eventTypes)
    })
  }

  async append(input: AppendBuddyRunEventInput): Promise<BuddyRunEvent> {
    return this.#execute(input.runId, 'append', () => this.#writer.append(input))
  }

  async appendBatch(inputs: readonly AppendBuddyRunEventInput[]): Promise<BuddyRunEvent[]> {
    return this.#execute(inputs[0]?.runId ?? '', 'append', () => this.#writer.appendBatch(inputs))
  }

  async read(runId: string): Promise<BuddyRunEvent[]> {
    buddyRunIdSchema.parse(runId)
    return this.#execute(runId, 'read', () => {
      this.#assertSequences([runId])
      return this.#queries.read(runId)
    })
  }

  async list(runId: string, options: ListBuddyRunEventsOptions = {}): Promise<BuddyRunEvent[]> {
    buddyRunIdSchema.parse(runId)
    assertPage(options)
    return this.#execute(runId, 'read', () => {
      this.#assertSequences([runId])
      return this.#queries.list(runId, options)
    })
  }

  listForConversation(conversationId: string, options: Pick<ListBuddyRunEventsOptions, 'limit'> = {}): BuddyRunEvent[] {
    assertPage(options)
    return this.#execute('', 'read', () => {
      const runs = this.#database.prepare('SELECT id FROM runs WHERE conversation_id = ?').all(conversationId) as Array<{ id: string }>
      this.#assertSequences(runs.map(run => run.id))
      return this.#queries.listForConversation(conversationId, options)
    })
  }

  listForRuns(runIds: readonly string[], options: { latestActivityOnly?: boolean } = {}): BuddyRunEvent[] {
    for (const runId of runIds)
      buddyRunIdSchema.parse(runId)
    return this.#execute('', 'read', () => {
      this.#assertSequences(runIds)
      return this.#queries.listForRuns(runIds, options)
    })
  }

  listToolCounts(runIds: readonly string[]): ReadonlyMap<string, number> {
    return this.#execute('', 'read', () => {
      this.#assertSequences(runIds)
      return this.#queries.listToolCounts(runIds)
    })
  }

  async compactTerminalRun(runId: string): Promise<number> {
    return this.#execute(runId, 'compact', () => this.#writer.compactTerminalRun(runId))
  }

  async compactTerminalRuns(): Promise<number> {
    let after = ''
    let removed = 0
    while (true) {
      const runIds = this.#execute('', 'read', () => this.#queries.listCompactableTerminalRunIds(after))
      if (!runIds.length)
        return removed
      for (const runId of runIds) {
        removed += await this.compactTerminalRun(runId)
        after = runId
      }
    }
  }

  startMaintenance(options?: RunEventMaintenanceOptions): void {
    this.#execute('', 'read', () => this.#maintenance.start(options))
  }

  stopMaintenance(): Promise<void> {
    return this.#maintenance.stop()
  }

  async recoverAll(options: RunEventRecoveryOptions = {}): Promise<Readonly<RunEventRecoverySummary>> {
    const started = performance.now()
    const runIds = this.#execute('', 'read', () => this.#queries.listRunIds())
    const enumerationMs = performance.now() - started
    let events = 0
    const progress = (completed: number) => {
      try {
        options.onProgress?.({ completed, total: runIds.length })
      }
      catch {}
    }
    progress(0)
    for (const [index, runId] of runIds.entries()) {
      events += (await this.read(runId)).length
      progress(index + 1)
    }
    const durationMs = performance.now() - started
    return Object.freeze({ durationMs, enumerationMs, inspectionMs: 0, readMs: durationMs - enumerationMs, projectionMs: 0, scanned: runIds.length, skipped: runIds.length, rebuilt: 0, events, failed: 0, failures: [] })
  }

  close(): Promise<void> {
    return this.#closePromise ??= (async () => {
      await this.stopMaintenance()
      try {
        if (this.state === 'open' && this.#database.isOpen)
          this.#execute('', 'checkpoint', () => checkpointSqliteStorage(this.#database))
      }
      finally {
        this.#closed = true
        this.#writer.dispose()
        this.#quarantineChanges.dispose()
      }
    })()
  }

  #assertSequences(runIds: readonly string[]): void {
    const invalid = this.#database.prepare(`
      SELECT 1 FROM runs WHERE id = ? AND (
        next_event_sequence IS NULL OR next_event_sequence > ? OR
        EXISTS (SELECT 1 FROM run_events WHERE run_id = runs.id AND sequence >= runs.next_event_sequence)
      )
    `)
    const unsupported = this.#database.prepare('SELECT 1 FROM run_events WHERE run_id = ? AND format_version != 1 LIMIT 1')
    for (const runId of new Set(runIds)) {
      if (invalid.get(runId, Number.MAX_SAFE_INTEGER))
        throw new Error('Run event sequence is unverified or inconsistent')
      if (unsupported.get(runId))
        throw new Error('Run event format is not supported')
    }
  }

  #execute<T>(runId: string, operation: RunEventDatabaseError['operation'], callback: () => T, committedRead = true): T {
    if (this.#failure)
      throw this.#failure
    try {
      if (this.#closed)
        throw new Error('SQLite run event log is closed')
      if (committedRead)
        assertCommittedRead(this.#database)
      else
        getStorageIsolation(this.#database).assertAvailable()
      requireSqliteAuthority(this.#database)
      return callback()
    }
    catch (cause) {
      this.#failure = new RunEventDatabaseError(runId, operation, cause)
      if (!this.#closed)
        getStorageIsolation(this.#database).isolate(this.#failure)
      try {
        this.#onFatalFailure?.(this.#failure)
      }
      catch {}
      throw this.#failure
    }
  }
}

function assertPage(options: ListBuddyRunEventsOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0))
    throw new TypeError('Run event limit must be a positive safe integer')
  if (options.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0))
    throw new TypeError('Run event cursor must be a nonnegative safe integer')
}
