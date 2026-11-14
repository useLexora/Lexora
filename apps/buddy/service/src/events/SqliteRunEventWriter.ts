import type { DatabaseSync } from 'node:sqlite'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { AppendBuddyRunEventInput, BuddyRunEvent } from './BuddyRunEvent'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { afterTransactionCommit, assertCommittedRead, withTransaction } from '../storage/transaction'
import { buddyRunEventSchema, buddyRunIdSchema, isTerminalRunEventType } from './BuddyRunEvent'
import { prepareEventPayload } from './prepareEventPayload'
import { createRunEventCompactionPlan } from './RunEventCompaction'
import { RunEventProjector } from './RunEventProjector'
import { RunEventQueries } from './RunEventQueries'
import { RUN_EVENT_COMPACTION_VERSION, RUN_EVENT_PROJECTION_VERSION } from './RunEventRecovery'

export class SqliteRunEventWriter {
  readonly #database: DatabaseSync
  readonly #projector: RunEventProjector
  readonly #queries: RunEventQueries
  readonly #committed: Emitter<EventSnapshot<BuddyRunEvent>>
  readonly #onObserverError: (error: unknown) => void
  readonly onDidCommit: Emitter<EventSnapshot<BuddyRunEvent>>['event']
  #disposed = false

  constructor(database: DatabaseSync, onObserverError: (error: unknown) => void = () => {}) {
    requireSqliteAuthority(database)
    this.#database = database
    this.#projector = new RunEventProjector(database)
    this.#queries = new RunEventQueries(database)
    this.#onObserverError = onObserverError
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  append(input: AppendBuddyRunEventInput): BuddyRunEvent {
    return this.appendBatch([input])[0]!
  }

  appendBatch(inputs: readonly AppendBuddyRunEventInput[]): BuddyRunEvent[] {
    return withTransaction(this.#database, () => {
      this.#assertWritable()
      if (inputs.length === 0)
        return []
      const runId = inputs[0]!.runId
      if (inputs.some(input => input.runId !== runId))
        throw new Error('A run event batch must belong to one run')
      const allocation = this.#database.prepare(`
        UPDATE runs SET next_event_sequence = next_event_sequence + ?
        WHERE id = ? AND next_event_sequence <= ?
          AND NOT EXISTS (SELECT 1 FROM run_events WHERE run_id = runs.id AND sequence >= runs.next_event_sequence)
        RETURNING next_event_sequence - ? AS first_sequence
      `).get(inputs.length, runId, Number.MAX_SAFE_INTEGER - inputs.length, inputs.length)
      if (!allocation || typeof allocation.first_sequence !== 'number')
        throw new Error('Run event sequence is missing, unverified, inconsistent or exhausted')
      const firstSequence = allocation.first_sequence
      const events = inputs.map((input, index) => buddyRunEventSchema.parse(JSON.parse(JSON.stringify({
        ...input,
        sequence: firstSequence + index,
        payload: prepareEventPayload(input, firstSequence + index),
        createdAt: input.createdAt ?? new Date().toISOString(),
      }))))
      this.#projector.append(events)
      this.#database.prepare('UPDATE run_event_maintenance SET recovery_pending = 0, projection_version = ? WHERE run_id = ?').run(RUN_EVENT_PROJECTION_VERSION, runId)
      const snapshots = events.map(event => copyEventSnapshot(event))
      afterTransactionCommit(this.#database, () => this.#committed.fireBatch(snapshots), this.#onObserverError)
      return events
    })
  }

  compactTerminalRun(runId: string): number {
    assertCommittedRead(this.#database)
    return withTransaction(this.#database, () => {
      this.#assertWritable()
      buddyRunIdSchema.parse(runId)
      const run = this.#database.prepare(`
        SELECT next_event_sequence IS NOT NULL AS verified,
          EXISTS (SELECT 1 FROM run_events
            WHERE run_id = runs.id AND sequence >= runs.next_event_sequence) AS invalid_sequence
        FROM runs WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')
      `).get(runId)
      if (!run)
        return 0
      if (!run.verified || run.invalid_sequence)
        throw new Error('Run event sequence is unverified or inconsistent')
      if (this.#database.prepare('SELECT 1 FROM run_events WHERE run_id = ? AND format_version != 1 LIMIT 1').get(runId))
        throw new Error('Run event format is not supported for compaction')
      const events = this.#queries.read(runId)
      if (!events.some(event => isTerminalRunEventType(event.type)))
        return 0
      const { removed } = createRunEventCompactionPlan(events)
      this.#projector.removeEventRows(runId, removed.map(event => event.sequence))
      this.#database.prepare('UPDATE run_event_maintenance SET recovery_pending = 0, projection_version = ?, compaction_pending = 0, compaction_version = ? WHERE run_id = ?').run(RUN_EVENT_PROJECTION_VERSION, RUN_EVENT_COMPACTION_VERSION, runId)
      return removed.length
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }

  #assertWritable(): void {
    if (this.#disposed)
      throw new Error('SQLite run event writer is stopped')
    requireSqliteAuthority(this.#database)
  }
}
