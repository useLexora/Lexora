import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent } from '../BuddyRunEvent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteRunFixtureTime as now, seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { withTransaction } from '../../storage/transaction'
import { createRunEventLog } from '../createRunEventLog'
import { SqliteRunEventLog } from '../SqliteRunEventLog'
import { SqliteRunEventWriter } from '../SqliteRunEventWriter'

const databases: DatabaseSync[] = []
const logs: SqliteRunEventLog[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const log of logs.splice(0))
    await log.close()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
})

function fixture(ready = true) {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  if (ready)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  return database
}

function log(database: DatabaseSync, onFatalFailure?: () => void) {
  const result = new SqliteRunEventLog({ database, onFatalFailure })
  logs.push(result)
  return result
}

describe('sqlite run event queries', () => {
  it('finishes all bounded maintenance pages and verifies committed facts without replaying them', async () => {
    const database = fixture()
    const events = log(database)
    for (let index = 0; index < 19; index++) {
      const runId = `run-${index}`
      seedSqliteRun(database, runId)
      await events.appendBatch([
        { runId, type: 'tool.preparing', payload: { toolCallId: `tool-${index}` } },
        { runId, type: 'tool.started', payload: { toolCallId: `tool-${index}` } },
        { runId, type: 'tool.completed', payload: { toolCallId: `tool-${index}` } },
        { runId, type: 'run.completed', payload: {} },
      ])
    }
    expect(await events.compactTerminalRuns()).toBe(19)
    expect(database.prepare('SELECT count(*) AS count FROM run_event_maintenance WHERE recovery_pending != 0 OR compaction_pending != 0').get()).toEqual({ count: 0 })
    const before = database.prepare('SELECT * FROM run_events ORDER BY run_id, sequence').all()
    expect(await events.recoverAll()).toMatchObject({ scanned: 19, rebuilt: 0, events: 57, failed: 0 })
    expect(database.prepare('SELECT * FROM run_events ORDER BY run_id, sequence').all()).toEqual(before)
    expect(events.listToolCounts(['run-1', 'run-2'])).toEqual(new Map([['run-1', 1], ['run-2', 1]]))
    expect(await events.findLatest('run-1', ['run.completed'])).toMatchObject({ sequence: 4 })
    expect(events.listForRuns(['run-1'], { latestActivityOnly: true })).toMatchObject([{ sequence: 4 }])
  })

  it('reads the full authority in sequence order and pages across compaction gaps without a time cursor', async () => {
    const database = fixture()
    seedSqliteRun(database, 'run-1')
    const events = log(database)
    await events.appendBatch(Array.from({ length: 602 }, (_, index) => ({
      runId: 'run-1',
      type: 'future.fact',
      payload: { index, nested: [null, { value: 'retained' }] },
      createdAt: new Date(Date.parse(now) - index).toISOString(),
    })))
    database.exec('DELETE FROM run_events WHERE sequence IN (2, 501)')
    expect(await events.read('run-1')).toHaveLength(600)
    expect((await events.list('run-1', { limit: 3 })).map(event => event.sequence)).toEqual([600, 601, 602])
    expect((await events.list('run-1', { afterSequence: 0, limit: 3 })).map(event => event.sequence)).toEqual([1, 3, 4])
    expect((await events.list('run-1', { afterSequence: 500, limit: 2 })).map(event => event.sequence)).toEqual([502, 503])
    await expect(events.list('run-1', { afterSequence: 602 })).resolves.toEqual([])
    await expect(events.read('missing')).resolves.toEqual([])
    const copy = (await events.read('run-1'))[0]!
    copy.payload = null
    expect((await events.read('run-1'))[0]?.payload).toEqual({ index: 0, nested: [null, { value: 'retained' }] })
    expect(database.prepare('SELECT next_event_sequence FROM runs').get()?.next_event_sequence).toBe(603)
  })

  it('keeps each run ordered within conversation and multi-run reads even when wall time moves backwards', async () => {
    const database = fixture()
    for (const id of ['run-a', 'run-b'])
      seedSqliteRun(database, id)
    seedSqliteRun(database, 'other', { conversationId: 'other-task' })
    const events = log(database)
    for (const id of ['run-b', 'run-a', 'other']) {
      await events.appendBatch([
        { runId: id, type: 'future.first', payload: {}, createdAt: '2026-09-29T00:00:02.000Z' },
        { runId: id, type: 'future.second', payload: {}, createdAt: now },
      ])
    }
    const ids = (items: BuddyRunEvent[]) => items.map(event => `${event.runId}:${event.sequence}`)
    expect(ids(events.listForRuns(['run-b', 'run-a', 'run-a']))).toEqual(['run-a:1', 'run-a:2', 'run-b:1', 'run-b:2'])
    expect(ids(events.listForConversation('task-1'))).toEqual(['run-a:1', 'run-a:2', 'run-b:1', 'run-b:2'])
    expect(ids(events.listForConversation('task-1', { limit: 3 }))).toEqual(['run-a:2', 'run-b:1', 'run-b:2'])
    expect(events.listForRuns([])).toEqual([])
    expect(events.listForConversation('missing')).toEqual([])
  })

  it('rejects pending authority and prevents both pending and ready candidates from entering legacy replay', () => {
    const database = fixture(false)
    expect(() => log(database)).toThrow('not ready')
    const legacy = () => createRunEventLog({ database, conversationsDirectory: '/unused-candidate-history' })
    expect(legacy).toThrow('Legacy JSONL replay')
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    expect(legacy).toThrow('Legacy JSONL replay')
    expect(log(database).state).toBe('open')
  })

  it.each(['read', 'list', 'conversation', 'runs'] as const)('refuses unknown durable formats on %s without repairing or replacing facts', async (method) => {
    const database = fixture()
    seedSqliteRun(database, 'run-1')
    const events = log(database, () => {
      throw new Error('reporter failed')
    })
    await events.append({ runId: 'run-1', type: 'future.fact', payload: { retained: true }, createdAt: now })
    database.exec('UPDATE run_events SET format_version = 2')
    const before = database.prepare('SELECT * FROM run_events').all()
    const read = () => method === 'read'
      ? events.read('run-1')
      : method === 'list'
        ? events.list('run-1')
        : method === 'conversation' ? events.listForConversation('task-1') : events.listForRuns(['run-1'])
    await expect(Promise.resolve().then(read)).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED', operation: 'read', cause: { message: 'Run event format is not supported' } })
    expect(events.state).toBe('failed')
    await expect(events.append({ runId: 'run-1', type: 'run.failed', payload: {} })).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
    expect(database.prepare('SELECT * FROM run_events').all()).toEqual(before)
    expect(database.prepare('SELECT status FROM runs').get()?.status).toBe('queued')
  })

  it.each(['unverified', 'conflicting', 'overflow'] as const)('does not return an empty history for a run with %s sequence metadata', async (kind) => {
    const database = fixture()
    if (kind === 'unverified')
      database.exec('UPDATE storage_profile SET authority = \'legacy_jsonl\', migration_state = \'pending\'')
    seedSqliteRun(database, 'run-1', { nextSequence: kind === 'unverified' ? null : 1 })
    if (kind === 'unverified')
      database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    if (kind === 'conflicting')
      database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 1, ?, ?, ?)').run('run-1', 'future.fact', '{}', now)
    if (kind === 'overflow')
      database.exec('UPDATE runs SET next_event_sequence = 9223372036854775807')
    await expect(log(database).read('run-1')).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED', operation: 'read' })
  })

  it('does not expose same-connection uncommitted events as durable history', async () => {
    const database = fixture()
    seedSqliteRun(database, 'run-1')
    const events = log(database)
    const writer = new SqliteRunEventWriter(database)
    expect(() => withTransaction(database, () => {
      writer.append({ runId: 'run-1', type: 'future.fact', payload: {} })
      events.listForRuns(['run-1'])
    })).toThrow('run event database failed')
    expect(database.prepare('SELECT * FROM run_events').all()).toEqual([])
    expect(events.state).toBe('failed')
    writer.dispose()
  })

  it('refuses reads after uncertain commit, closed connection, and explicit close', async () => {
    const database = fixture()
    seedSqliteRun(database, 'run-1')
    const events = log(database)
    const exec = database.exec.bind(database)
    const failure = new Error('commit acknowledgement unavailable')
    vi.spyOn(database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw failure
    })
    await expect(events.append({ runId: 'run-1', type: 'future.fact', payload: {} })).rejects.toMatchObject({ commitState: 'unknown', cause: { code: 'STORAGE_TRANSACTION_UNCERTAIN', cause: failure } })
    await expect(events.read('run-1')).rejects.toMatchObject({ commitState: 'unknown' })
    expect(() => log(database)).toThrow('requires verification')
    vi.restoreAllMocks()
    const closedDatabase = fixture()
    const closed = log(closedDatabase)
    closedDatabase.close()
    await expect(closed.read('run-1')).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
    const stopped = log(fixture())
    await stopped.close()
    expect(stopped.state).toBe('closed')
    await expect(stopped.read('run-1')).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
  })
})
