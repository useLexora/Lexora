import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import type { AppendBuddyRunEventInput, BuddyRunEvent } from '../BuddyRunEvent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executionMailboxMessageSchema } from '../../../../shared/executions/executionApi'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createMailboxRepository, hashExecutionMailboxMessage } from '../../storage/mailboxRepository'
import { BUDDY_V43_PERSISTENCE_SCHEMA_SQL } from '../../storage/migrations/v43Persistence'
import { BUDDY_MIGRATION_SCHEMA_VERSION } from '../../storage/schema'
import { readTransactionFailure, withTransaction } from '../../storage/transaction'
import { RunEventQueries } from '../RunEventQueries'
import { SqliteRunEventWriter } from '../SqliteRunEventWriter'

const databases: SqliteDatabase[] = []
const writers: SqliteRunEventWriter[] = []
const directories: string[] = []
const now = '2026-09-29T00:00:00.000Z'

afterEach(() => {
  vi.restoreAllMocks()
  for (const writer of writers.splice(0))
    writer.dispose()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function open(databasePath = ':memory:') {
  const database = openBuddyMigrationCandidate({ databasePath })
  databases.push(database)
  return database
}

function writer(database: SqliteDatabase, onObserverError?: (error: unknown) => void) {
  const events = new SqliteRunEventWriter(database, onObserverError)
  writers.push(events)
  return events
}

function seedRun(database: SqliteDatabase, runId: string, nextSequence: number | null = 1) {
  database.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(`task-${runId}`, now, now)
  database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${runId}`, `task-${runId}`, now)
  database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, \'user\', ?, ?)').run(`input-${runId}`, `task-${runId}`, `branch-${runId}`, '{"text":"Fixture input"}', now)
  database.prepare(`
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, next_event_sequence)
    VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'queued', ?, ?)
  `).run(runId, `task-${runId}`, `branch-${runId}`, `input-${runId}`, now, nextSequence)
}

function fixture(databasePath = ':memory:', nextSequence: number | null = 1) {
  const database = open(databasePath)
  seedRun(database, 'run-1', nextSequence)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  return { database, writer: writer(database), queries: new RunEventQueries(database) }
}

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-sqlite-events-'))
  directories.push(directory)
  return join(directory, 'candidate.sqlite3')
}

function event(type: string, payload: unknown = {}, createdAt = now): AppendBuddyRunEventInput {
  return { runId: 'run-1', type, payload, createdAt }
}

function history(): AppendBuddyRunEventInput[] {
  return [
    event('run.started'),
    event('run.progress', { stage: 'thinking' }),
    event('message.delta', { messageId: 'answer-1', text: 'Answer' }),
    event('message.completed', { messageId: 'answer-1', role: 'assistant', content: { text: 'Answer' }, stopReason: 'completed' }),
    event('tool.preparing', { toolCallId: 'tool-1' }),
    event('tool.updated', { toolCallId: 'tool-1', text: 'Working' }),
    event('tool.completed', { toolCallId: 'tool-1' }),
    event('approval.requested', {
      id: 'approval-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      kind: 'shell',
      status: 'pending',
      summary: 'Fixture approval',
      payload: { card: 'shell', toolName: 'bash', command: 'fixture', allowForTurn: false },
      createdAt: now,
      resolvedAt: null,
    }),
    event('approval.resolved', { id: 'approval-1', status: 'denied', resolvedAt: now }),
    event('usage.recorded', {
      usageRecordId: 'usage-1',
      sourceEntryId: 'source-1',
      provider: 'fixture',
      model: 'fixture',
      purpose: 'turn',
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: null,
      totalTokens: 5,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
    }),
    event('future.opaque', { retained: [null, { value: 'unchanged' }] }),
    event('run.completed'),
    event('run.progress', { stage: 'settled' }),
  ]
}

function projections(database: SqliteDatabase) {
  return Object.fromEntries(['runs', 'messages', 'approvals', 'usage_records', 'command_receipts'].map(table => [table, database.prepare(`SELECT * FROM ${table}`).all()]))
}

function watermark(database: SqliteDatabase) {
  return database.prepare('SELECT CAST(next_event_sequence AS TEXT) AS value FROM runs WHERE id = \'run-1\'').get()!.value
}

function capture(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error('Expected operation to fail')
}

describe('sQLite run event sequence and commit notifications', () => {
  it('commits child results, mailbox identity and projections together without publishing private replies', () => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    f.executions.admitChild(f.child('child'))
    withTransaction(f.database, () => {
      f.database.exec(BUDDY_V43_PERSISTENCE_SCHEMA_SQL)
      f.database.exec(`PRAGMA user_version = ${BUDDY_MIGRATION_SCHEMA_VERSION}`)
      f.database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'; UPDATE runs SET next_event_sequence = 1')
    })
    const events = writer(f.database)
    const delivered: number[] = []
    events.onDidCommit(event => delivered.push(event.sequence))
    const batch = [
      { runId: 'child', type: 'message.completed', payload: { role: 'assistant', messageId: 'private-answer', content: { text: 'Private result' }, stopReason: 'completed' } },
      { runId: 'child', type: 'execution.mailbox.sent', payload: { kind: 'result', messageId: 'result-child', targetRunId: 'root', targetGeneration: 0, text: 'Research result' } },
      { runId: 'child', type: 'run.completed', payload: {} },
    ]
    f.database.exec('CREATE TRIGGER reject_mailbox BEFORE INSERT ON execution_mailbox_sources BEGIN SELECT RAISE(ABORT, \'projection unavailable\'); END')
    expect(() => events.appendBatch(batch)).toThrow('projection unavailable')
    expect(f.database.prepare('SELECT sequence FROM run_events').all()).toEqual([])
    expect(f.database.prepare('SELECT next_event_sequence FROM runs WHERE id = \'child\'').get()).toEqual({ next_event_sequence: 1 })
    expect(delivered).toEqual([])
    f.database.exec('DROP TRIGGER reject_mailbox')
    const committed = events.appendBatch(batch)
    const message = executionMailboxMessageSchema.parse(committed[1]!.payload)
    expect(message).toMatchObject({ sourceRunId: 'child', sourceSequence: 2 })
    expect(message.payloadHash).toBe(hashExecutionMailboxMessage(message))
    expect(createMailboxRepository(f.database).listPending('root')).toEqual([message])
    expect(f.database.prepare('SELECT id FROM messages WHERE id = \'private-answer\'').get()).toBeUndefined()
    expect(f.executions.find('child')?.phase).toBe('closed')
    expect(delivered).toEqual([1, 2, 3])
    const receipt = { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: 'entry-result' }
    events.appendBatch([
      { runId: 'root', type: 'execution.mailbox.accepted', payload: receipt },
      { runId: 'root', type: 'execution.mailbox.consumed', payload: receipt },
    ])
    expect(createMailboxRepository(f.database).find(message.messageId)?.state).toBe('consumed')
  })

  it('preserves the durable watermark and projections when the highest event is compacted, including after reopen', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    f.writer.appendBatch(history())
    const before = projections(f.database)
    const delivered: number[] = []
    f.writer.onDidCommit(event => delivered.push(event.sequence))
    expect(f.writer.compactTerminalRun('run-1')).toBe(5)
    expect(f.queries.read('run-1').map(event => event.sequence)).toEqual([1, 4, 7, 8, 9, 10, 11, 12])
    expect(f.queries.read('run-1').find(event => event.type === 'future.opaque')?.payload).toEqual({ retained: [null, { value: 'unchanged' }] })
    expect(projections(f.database)).toEqual(before)
    expect(watermark(f.database)).toBe('14')
    expect(f.writer.compactTerminalRun('run-1')).toBe(0)
    expect(delivered).toEqual([])
    f.writer.dispose()
    f.database.close()

    const database = open(databasePath)
    const reopened = writer(database)
    expect(reopened.compactTerminalRun('run-1')).toBe(0)
    expect(reopened.append(event('desktop.panel.changed', { action: 'close' })).sequence).toBe(14)
    expect(watermark(database)).toBe('15')
    expect(new RunEventQueries(database).read('run-1').map(event => event.sequence)).toEqual([1, 4, 7, 8, 9, 10, 11, 12, 14])
  })

  it('uses sequence order instead of wall time to retain the latest tool replacement', () => {
    const f = fixture()
    f.writer.appendBatch([
      event('tool.updated', { toolCallId: 'tool-1', text: 'Old' }, '2026-09-29T00:00:02.000Z'),
      event('tool.updated', { toolCallId: 'tool-1', text: 'Latest' }, '2026-09-29T00:00:01.000Z'),
      event('run.completed'),
    ])
    expect(f.writer.compactTerminalRun('run-1')).toBe(1)
    expect(f.queries.read('run-1')).toMatchObject([
      { sequence: 2, type: 'tool.updated', payload: { text: 'Latest' } },
      { sequence: 3, type: 'run.completed' },
    ])
    expect(watermark(f.database)).toBe('4')
  })

  it('compacts the entire history without using a latest-page limit', () => {
    const f = fixture()
    f.writer.appendBatch([...Array.from({ length: 600 }, (_, index) => event('run.progress', { index })), event('run.completed')])
    expect(f.writer.compactTerminalRun('run-1')).toBe(600)
    expect(f.queries.read('run-1')).toMatchObject([{ sequence: 601, type: 'run.completed' }])
    expect(f.writer.append(event('desktop.panel.changed')).sequence).toBe(602)
  })

  it.each(['queued', 'running'])('preserves events while the run is %s even if a terminal fact is present', (status) => {
    const f = fixture()
    f.writer.appendBatch(history())
    f.database.prepare('UPDATE runs SET status = ? WHERE id = \'run-1\'').run(status)
    const before = f.queries.read('run-1')
    expect(f.writer.compactTerminalRun('run-1')).toBe(0)
    expect(f.queries.read('run-1')).toEqual(before)
  })

  it('requires a durable terminal fact before deleting events', () => {
    const f = fixture()
    f.writer.append(event('run.progress'))
    f.database.exec('UPDATE runs SET status = \'completed\' WHERE id = \'run-1\'')
    expect(f.writer.compactTerminalRun('run-1')).toBe(0)
    expect(f.queries.read('run-1')).toHaveLength(1)
  })

  it('rolls back every deletion when a later compaction row fails', () => {
    const f = fixture()
    f.writer.appendBatch(history())
    const before = f.queries.read('run-1')
    f.database.exec(`CREATE TRIGGER refuse_tail BEFORE DELETE ON run_events WHEN OLD.sequence = 13
      BEGIN SELECT RAISE(ABORT, 'tail retained'); END`)
    expect(() => f.writer.compactTerminalRun('run-1')).toThrow('tail retained')
    expect(f.queries.read('run-1')).toEqual(before)
    expect(watermark(f.database)).toBe('14')
    f.database.exec('DROP TRIGGER refuse_tail')
    expect(f.writer.compactTerminalRun('run-1')).toBe(5)
  })

  it('allows compaction only after staged events have committed and become observable', () => {
    const f = fixture()
    f.writer.appendBatch(history())
    const delivered: number[] = []
    f.writer.onDidCommit(event => delivered.push(event.sequence))
    withTransaction(f.database, () => {
      f.writer.append(event('run.progress'))
      expect(() => f.writer.compactTerminalRun('run-1')).toThrow('active transaction')
      expect(delivered).toEqual([])
    })
    expect(delivered).toEqual([14])
    expect(f.queries.read('run-1')).toHaveLength(14)
    expect(f.writer.compactTerminalRun('run-1')).toBe(6)
    expect(watermark(f.database)).toBe('15')
    expect(f.writer.append(event('desktop.panel.changed')).sequence).toBe(15)
  })

  it('refuses unverified and inconsistent sequence metadata before compaction can erase the evidence', () => {
    const unverified = fixture(':memory:', null)
    unverified.database.exec('UPDATE runs SET status = \'completed\' WHERE id = \'run-1\'')
    expect(() => unverified.writer.append(event('audit.recorded'))).toThrow('unverified')
    expect(() => unverified.writer.compactTerminalRun('run-1')).toThrow('unverified')
    expect(watermark(unverified.database)).toBeNull()

    const inconsistent = fixture()
    inconsistent.writer.appendBatch(history())
    inconsistent.database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 14, ?, ?, ?)').run('run-1', 'run.progress', '{}', now)
    expect(() => inconsistent.writer.compactTerminalRun('run-1')).toThrow('inconsistent')
    expect(() => inconsistent.writer.append(event('audit.recorded'))).toThrow('inconsistent')
    expect(inconsistent.queries.read('run-1')).toHaveLength(14)
    expect(watermark(inconsistent.database)).toBe('14')
  })

  it('refuses to append below an existing higher fact even when the next sequence itself is unused', () => {
    const f = fixture()
    f.database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 8, ?, ?, ?)').run('run-1', 'audit.original', '{}', now)
    expect(() => f.writer.append(event('audit.recorded'))).toThrow('inconsistent')
    expect(watermark(f.database)).toBe('1')
    expect(f.queries.read('run-1')).toMatchObject([{ sequence: 8, type: 'audit.original' }])
  })

  it('preserves unsupported event formats and stops maintenance after disposal or loss of authority', () => {
    const f = fixture()
    f.writer.appendBatch(history())
    f.database.exec('UPDATE run_events SET format_version = 2 WHERE sequence = 2')
    const before = f.database.prepare('SELECT * FROM run_events ORDER BY sequence').all()
    expect(() => f.writer.compactTerminalRun('run-1')).toThrow('format is not supported')
    expect(f.database.prepare('SELECT * FROM run_events ORDER BY sequence').all()).toEqual(before)
    f.database.exec('UPDATE storage_profile SET authority = \'legacy_jsonl\', migration_state = \'pending\'')
    expect(() => f.writer.compactTerminalRun('run-1')).toThrow('authority is not ready')
    f.writer.dispose()
    expect(() => f.writer.compactTerminalRun('run-1')).toThrow('writer is stopped')
    expect(f.database.prepare('SELECT * FROM run_events ORDER BY sequence').all()).toEqual(before)
  })

  it('allocates exactly representable sequences and rejects a batch that would exhaust the watermark', () => {
    const f = fixture()
    f.database.prepare('UPDATE runs SET next_event_sequence = ?').run(Number.MAX_SAFE_INTEGER - 1)
    expect(() => f.writer.appendBatch([event('audit.first'), event('audit.second')])).toThrow('exhausted')
    expect(f.queries.read('run-1')).toEqual([])
    expect(watermark(f.database)).toBe(String(Number.MAX_SAFE_INTEGER - 1))
    expect(f.writer.append(event('audit.last')).sequence).toBe(Number.MAX_SAFE_INTEGER - 1)
    expect(watermark(f.database)).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(() => f.writer.append(event('audit.overflow'))).toThrow('exhausted')
    f.database.prepare('UPDATE runs SET next_event_sequence = ?').run(9223372036854775807n)
    expect(() => f.writer.append(event('audit.int64'))).toThrow('exhausted')
    expect(watermark(f.database)).toBe('9223372036854775807')
    expect(f.queries.read('run-1')).toHaveLength(1)
  })

  it('allocates from SQLite across independent connections and keeps different runs independent', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const second = open(databasePath)
    const other = writer(second)
    expect(f.writer.appendBatch([event('audit.first'), event('audit.second')]).map(event => event.sequence)).toEqual([1, 2])
    expect(other.append(event('audit.third')).sequence).toBe(3)
    expect(f.writer.append(event('audit.fourth')).sequence).toBe(4)
    seedRun(f.database, 'run-2')
    expect(other.append({ ...event('audit.independent'), runId: 'run-2' }).sequence).toBe(1)
    expect(f.queries.read('run-1').map(event => event.sequence)).toEqual([1, 2, 3, 4])
    expect(watermark(f.database)).toBe('5')
  })

  it('publishes committed batches in FIFO order even when observers append and report failures', async () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const reader = new DatabaseSync(databasePath, { readOnly: true })
    databases.push(reader)
    const failures: unknown[] = []
    const events = writer(f.database, (error) => {
      failures.push(error)
      throw new Error('Reporter unavailable')
    })
    const first: number[] = []
    const second: number[] = []
    const syncFailure = new Error('Sync observer unavailable')
    const asyncFailure = new Error('Async observer unavailable')
    events.onDidCommit((committed) => {
      expect(f.database.isTransaction).toBe(false)
      expect(reader.prepare('SELECT 1 FROM run_events WHERE run_id = ? AND sequence = ?').get(committed.runId, committed.sequence)).toBeDefined()
      first.push(committed.sequence)
      if (committed.sequence === 1)
        events.append(event('audit.reentrant'))
      if (committed.sequence === 2)
        throw syncFailure
      if (committed.sequence === 3)
        return Promise.reject(asyncFailure)
    })
    events.onDidCommit(committed => second.push(committed.sequence))
    withTransaction(f.database, () => {
      events.appendBatch([event('audit.first'), event('audit.second')])
      events.append(event('audit.third'))
      expect(first).toEqual([])
      expect(second).toEqual([])
    })
    expect(first).toEqual([1, 2, 3, 4])
    expect(second).toEqual([1, 2, 3, 4])
    await Promise.resolve()
    expect(failures).toEqual([syncFailure, asyncFailure])
    expect(watermark(f.database)).toBe('5')
  })

  it('publishes frozen persisted snapshots even when inputs and returned values change before commit', () => {
    const f = fixture()
    const source = { nested: { value: 'persisted' } }
    const delivered: unknown[] = []
    f.writer.onDidCommit(committed => delivered.push(committed))
    withTransaction(f.database, () => {
      const result = f.writer.append(event('audit.snapshot', source))
      source.nested.value = 'changed input'
      ;(result.payload as typeof source).nested.value = 'changed return value'
      expect(delivered).toEqual([])
    })
    const committed = delivered[0] as BuddyRunEvent
    expect(committed.payload).toEqual({ nested: { value: 'persisted' } })
    expect(Object.isFrozen(committed)).toBe(true)
    expect(Object.isFrozen((committed.payload as typeof source).nested)).toBe(true)
    expect(f.queries.read('run-1')[0]).toEqual(committed)
  })

  it('does not advance the sequence or notify when a real COMMIT BUSY rolls back', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    f.writer.append(event('audit.first'))
    f.database.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0')
    const reader = new DatabaseSync(databasePath)
    databases.push(reader)
    reader.exec('BEGIN; SELECT * FROM run_events')
    const delivered: number[] = []
    f.writer.onDidCommit(event => delivered.push(event.sequence))
    const failure = capture(() => f.writer.append(event('audit.busy')))
    expect(failure).toMatchObject({ errcode: 5 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'commit', outcome: 'rolled_back' })
    expect(watermark(f.database)).toBe('2')
    expect(f.queries.read('run-1')).toHaveLength(1)
    expect(delivered).toEqual([])
    reader.exec('ROLLBACK')
    expect(f.writer.append(event('audit.retry')).sequence).toBe(2)
    expect(delivered).toEqual([2])
  })

  it('retains a committed but unacknowledged sequence across reopen without publishing early success', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    f.writer.append(event('audit.first'))
    const exec = f.database.exec.bind(f.database)
    const injected = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw new Error('COMMIT response lost')
    })
    const delivered: number[] = []
    f.writer.onDidCommit(event => delivered.push(event.sequence))
    const failure = capture(() => f.writer.append(event('audit.unacknowledged')))
    expect(readTransactionFailure(failure)).toMatchObject({ phase: 'commit', outcome: 'unknown' })
    expect(delivered).toEqual([])
    expect(() => f.writer.append(event('audit.blocked'))).toThrow('requires verification')
    expect(() => f.writer.compactTerminalRun('run-1')).toThrow('requires verification')
    injected.mockRestore()
    f.writer.dispose()
    f.database.close()
    const database = open(databasePath)
    expect(writer(database).append(event('audit.after-reopen')).sequence).toBe(3)
    expect(new RunEventQueries(database).read('run-1').map(event => [event.sequence, event.type])).toEqual([
      [1, 'audit.first'],
      [2, 'audit.unacknowledged'],
      [3, 'audit.after-reopen'],
    ])
  })
})
