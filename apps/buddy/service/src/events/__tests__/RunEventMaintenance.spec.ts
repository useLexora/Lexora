import type { RunEventLogCallbacks } from '../RunEventLog'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { BUDDY_SCHEMA_MIGRATIONS } from '../../storage/schema'
import { createRunEventLog } from '../createRunEventLog'
import { RunEventMaintenanceRetryableError, RunEventStorageError } from '../RunEventFailure'
import { RunEventStore } from '../RunEventStore'

interface MaintenanceFixture {
  root: string
  database: DatabaseSync
  log: ReturnType<typeof createRunEventLog>
  addRun: (runId: string) => void
  file: (runId?: string) => string
  reopen: () => Promise<void>
}

const fixtures: MaintenanceFixture[] = []
const NOW = '2026-10-04T00:00:00.000Z'

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.log.close()
    f.database.close()
    await rm(f.root, { force: true, recursive: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('durable event maintenance', () => {
  it('commits a terminal run before background compaction, retaining its independent recovery certificate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const summary = Promise.withResolvers<unknown>()
    const f = await fixture({ onMaintenance: value => summary.resolve(value) })
    await f.log.append({ runId: 'run-1', type: 'run.progress', payload: {} })
    const lifecycle = new RunLifecycleService({ eventLog: f.log, repository: createRunRepository(f.database) })
    await expect(lifecycle.finalize({ runId: 'run-1', status: 'completed', completedAt: NOW, errorCode: null })).resolves.toMatchObject({ status: 'completed' })
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 1 })
    expect((await f.log.read('run-1')).map(event => event.type)).toEqual(['run.progress', 'run.completed'])
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, rebuilt: 0 })
    f.log.startMaintenance()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(summary.promise).resolves.toMatchObject({ checked: 1, removed: 1, failed: 0 })
    await f.log.stopMaintenance()
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 0 })
    expect((await f.log.read('run-1')).map(event => event.type)).toEqual(['run.completed'])
    await lifecycle.dispose()
  })

  it.each(['stop', 'close'] as const)('%s waits for the current atomic replacement without draining the remaining queue', async (operation) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture()
    await seedTerminal(f)
    f.addRun('run-2')
    await seedTerminal(f, 'run-2')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = RunEventStore.prototype.replace
    vi.spyOn(RunEventStore.prototype, 'replace').mockImplementationOnce(async function (this: RunEventStore, ...args) {
      entered.resolve()
      await release.promise
      return original.apply(this, args)
    })
    f.log.startMaintenance()
    f.log.startMaintenance()
    await vi.advanceTimersByTimeAsync(1_000)
    await entered.promise
    let stopped = false
    const stop = (operation === 'close' ? f.log.close() : f.log.stopMaintenance()).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release.resolve()
    await stop
    expect(maintenance(f.database)).toMatchObject({ compaction_pending: 0 })
    expect(maintenance(f.database, 'run-2')).toMatchObject({ compaction_pending: 1 })
    expect((await readFile(f.file('run-2'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, rebuilt: 0 })
    expect(await f.log.compactTerminalRuns()).toBe(1)
    expect(await f.log.list('run-2')).toHaveLength(2)
  })

  it('bounds each background batch and defers busy work without waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 100
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const summaries: { checked: number, removed: number }[] = []
    let completed = Promise.withResolvers<void>()
    const f = await fixture({ onMaintenance: (summary) => {
      summaries.push(summary)
      completed.resolve()
    } })
    for (let index = 1; index <= 18; index++) {
      if (index > 1)
        f.addRun(`run-${index}`)
      await seedTerminal(f, `run-${index}`)
    }
    f.log.startMaintenance({ isBusy: () => true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_event_maintenance WHERE compaction_pending = 1').get()).toEqual({ count: 18 })
    clock += 30_001
    await vi.advanceTimersByTimeAsync(1_000)
    await completed.promise
    await f.log.stopMaintenance()
    expect(summaries).toMatchObject([{ checked: 1, removed: 1 }])
    completed = Promise.withResolvers<void>()
    f.log.startMaintenance()
    await vi.advanceTimersByTimeAsync(1_000)
    await completed.promise
    await f.log.stopMaintenance()
    expect(summaries).toMatchObject([{ checked: 1 }, { checked: 16, removed: 16 }])
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_event_maintenance WHERE compaction_pending = 1').get()).toEqual({ count: 1 })
  })

  it('serializes concurrent compactions without modifying a queued run early', async () => {
    const f = await fixture()
    await seedTerminal(f)
    f.addRun('run-2')
    await seedTerminal(f, 'run-2')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const replace = RunEventStore.prototype.replace
    vi.spyOn(RunEventStore.prototype, 'replace').mockImplementationOnce(async function (this: RunEventStore, ...args) {
      entered.resolve()
      await release.promise
      return replace.apply(this, args)
    })
    const first = f.log.compactTerminalRun('run-1')
    await entered.promise
    const second = f.log.compactTerminalRun('run-2')
    await Promise.resolve()
    expect(maintenance(f.database, 'run-2')).toMatchObject({ recovery_pending: 0, compaction_pending: 1 })
    expect((await readFile(f.file('run-2'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)
    release.resolve()
    expect(await Promise.all([first, second])).toEqual([1, 1])
    expect((await f.log.read('run-2')).map(event => event.sequence)).toEqual([1, 3])
  })

  it('retries a pre-replacement failure without failing the event log or losing the durable pending work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = Promise.withResolvers<void>()
    const succeeded = Promise.withResolvers<void>()
    const f = await fixture({ onMaintenance: (summary) => {
      if (summary.failed)
        failed.resolve()
      if (summary.removed)
        succeeded.resolve()
    } })
    await seedTerminal(f)
    const original = await readFile(f.file(), 'utf8')
    vi.spyOn(RunEventStore.prototype, 'replace').mockRejectedValueOnce(new RunEventMaintenanceRetryableError(new Error('temporary preparation unavailable')))
    f.log.startMaintenance()
    await vi.advanceTimersByTimeAsync(1_000)
    await failed.promise
    expect(f.log.state).toBe('open')
    expect(await readFile(f.file(), 'utf8')).toBe(original)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1, compaction_pending: 1 })
    await vi.advanceTimersByTimeAsync(30_001)
    await succeeded.promise
    await f.log.stopMaintenance()
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 0 })
  })

  it('keeps replacement uncertainty fatal and stops further background claims', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fatal = Promise.withResolvers<unknown>()
    const f = await fixture({ onFatalFailure: error => fatal.resolve(error) })
    await seedTerminal(f)
    f.addRun('run-2')
    await seedTerminal(f, 'run-2')
    const failure = new RunEventStorageError({ runId: 'run-1', firstSequence: 1, lastSequence: 3 }, 'compact', 'rename', 'unknown')
    vi.spyOn(RunEventStore.prototype, 'replace').mockRejectedValueOnce(failure)
    f.log.startMaintenance()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(fatal.promise).resolves.toBe(failure)
    await f.log.stopMaintenance()
    expect(f.log.state).toBe('failed')
    expect(maintenance(f.database, 'run-2')).toMatchObject({ compaction_pending: 1 })
    expect((await readFile(f.file('run-2'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('recovers a replacement committed before SQLite projection failed without renumbering retained facts', async () => {
    const f = await fixture()
    await seedTerminal(f)
    f.database.exec(`CREATE TRIGGER reject_compaction BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END;`)
    await expect(f.log.compactTerminalRun('run-1')).rejects.toMatchObject({ code: 'EVENT_PROJECTION_FAILED', commitState: 'committed' })
    expect(f.log.state).toBe('failed')
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1, compaction_pending: 1 })
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 3 })
    expect((await readFile(f.file(), 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
    f.database.exec('DROP TRIGGER reject_compaction')
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, rebuilt: 1, events: 2 })
    expect((await f.log.read('run-1')).map(event => event.sequence)).toEqual([1, 3])
    expect(await f.log.compactTerminalRuns()).toBe(0)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 0 })
  })

  it('marks recovery before the file append and restores a durable append whose projection never ran', async () => {
    const f = await fixture()
    await seedTerminal(f)
    const append = RunEventStore.prototype.append
    vi.spyOn(RunEventStore.prototype, 'append').mockImplementationOnce(async function (this: RunEventStore, events) {
      expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1, compaction_pending: 1 })
      expect(f.database.prepare('SELECT * FROM run_event_checkpoints').get()).toBeUndefined()
      await append.call(this, events)
      throw new RunEventStorageError({ runId: 'run-1', firstSequence: 4, lastSequence: 4 }, 'append', 'close', 'committed')
    })
    await expect(f.log.append({ runId: 'run-1', type: 'future.audit', payload: { retained: true } })).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
    expect(f.database.prepare('SELECT MAX(sequence) AS sequence FROM run_events').get()).toEqual({ sequence: 3 })
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, rebuilt: 1, events: 4 })
    expect(await f.log.findLatest('run-1', ['future.audit'])).toMatchObject({ sequence: 4, payload: { retained: true } })
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0 })
  })

  it.each(['append', 'replace'] as const)('does not certify a projection changed by external SQL during %s I/O', async (operation) => {
    const f = await fixture()
    await f.log.append({ runId: 'run-1', type: 'message.completed', payload: { messageId: 'answer', role: 'assistant', content: { text: 'durable answer' }, stopReason: 'completed' } })
    await seedTerminal(f)
    const damage = () => f.database.exec(`UPDATE messages SET content_json = '{"text":"external corruption"}' WHERE id = 'answer'`)
    if (operation === 'append') {
      const append = RunEventStore.prototype.append
      vi.spyOn(RunEventStore.prototype, 'append').mockImplementationOnce(async function (this: RunEventStore, events) {
        await append.call(this, events)
        damage()
      })
      await f.log.append({ runId: 'run-1', type: 'future.audit', payload: {} })
    }
    else {
      const replace = RunEventStore.prototype.replace
      vi.spyOn(RunEventStore.prototype, 'replace').mockImplementationOnce(async function (this: RunEventStore, ...args) {
        await replace.apply(this, args)
        damage()
      })
      await f.log.compactTerminalRun('run-1')
    }
    expect(f.database.prepare('SELECT content_json FROM messages WHERE id = ?').get('answer')).toEqual({ content_json: '{"text":"durable answer"}' })
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0 })
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, rebuilt: 0 })
  })

  it.each(['read', 'list', 'findLatest', 'verifyRun'] as const)('detects missing and corrupt external history on exact %s after a clean reopen', async (operation) => {
    const f = await fixture()
    await seedTerminal(f)
    const original = await readFile(f.file(), 'utf8')
    await f.reopen()
    await appendFile(f.file(), '{broken}\n')
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, failed: 0 })
    const read = () => operation === 'findLatest' ? f.log.findLatest('run-1', ['future.audit']) : f.log[operation]('run-1')
    await expect(read()).rejects.toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
    expect(await readFile(f.file(), 'utf8')).toBe(`${original}{broken}\n`)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1 })
    await f.reopen()
    await rm(f.file())
    await expect(read()).rejects.toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 3 })
  })

  it.each([
    ['messages', `INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      VALUES ('answer', 'conversation-1', 'branch-1', 'run-1', 'assistant', '{"text":"retained answer"}', '${NOW}')`],
    ['approvals', `INSERT INTO approvals (id, run_id, tool_call_id, kind, status, summary, payload_json, created_at)
      VALUES ('approval', 'run-1', 'tool', 'read', 'approved', 'retained approval', '{}', '${NOW}')`],
    ['usage_records', `INSERT INTO usage_records (id, run_id, source_entry_id, provider, model, purpose, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at)
      VALUES ('usage', 'run-1', 'entry', 'fixture', 'fixture', 'turn', 1, 1, 0, 0, 2, 0, 0, 0, 0, 0, '${NOW}')`],
    ['execution_mailbox_sources', `INSERT INTO execution_mailbox_sources
      VALUES ('mailbox', 'run-1', 1, 'run-1', 0, '{}', 'retained-hash', '${NOW}')`],
    ['execution_mailbox_receipts', `INSERT INTO execution_mailbox_receipts
      VALUES ('mailbox', 'run-1', 1, 'run-1', 'retained-hash', 'accepted', 'entry', NULL, '${NOW}')`],
  ])('preserves legacy %s facts when both the event index and log are missing or empty', async (table, sql) => {
    const f = await fixture({}, true)
    f.database.exec(`UPDATE runs SET status = 'completed' WHERE id = 'run-1'; ${sql};`)
    const before = f.database.prepare(`SELECT * FROM ${table}`).all()
    const columns = Object.keys(before[0]!).join(', ')
    await f.reopen()
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1 })
    await expect(f.log.verifyRun('run-1')).rejects.toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, failed: 1, rebuilt: 0 })
    expect(f.database.prepare(`SELECT ${columns} FROM ${table}`).all()).toEqual(before)
    await mkdir(join(f.root, 'conversations', 'conversation-1', 'events'), { recursive: true })
    await writeFile(f.file(), '')
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ failed: 1, rebuilt: 0 })
    expect(f.database.prepare(`SELECT ${columns} FROM ${table}`).all()).toEqual(before)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1 })
  })

  it('certifies an empty terminal run without rebuilding or repeating recovery on reopen', async () => {
    const f = await fixture()
    f.database.exec('UPDATE runs SET status = \'completed\' WHERE id = \'run-1\'')
    const before = f.database.prepare('SELECT * FROM runs WHERE id = ?').get('run-1')
    expect(await f.log.recoverAll({ force: true })).toMatchObject({ scanned: 1, skipped: 1, rebuilt: 0, events: 0, failed: 0 })
    expect(f.database.prepare('SELECT * FROM runs WHERE id = ?').get('run-1')).toEqual(before)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 0 })
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, rebuilt: 0, failed: 0 })
    expect(await f.log.read('run-1')).toEqual([])
    expect(await f.log.append({ runId: 'run-1', type: 'future.audit', payload: {} })).toMatchObject({ sequence: 1 })
  })

  it('does not compact active runs and rechecks a terminal run only after compaction-version invalidation', async () => {
    const f = await fixture()
    await f.log.append({ runId: 'run-1', type: 'tool.updated', payload: { toolCallId: 'tool-1' } })
    await f.log.append({ runId: 'run-1', type: 'run.progress', payload: {} })
    const active = await readFile(f.file(), 'utf8')
    expect(await f.log.compactTerminalRuns()).toBe(0)
    expect(await f.log.compactTerminalRun('run-1')).toBe(0)
    expect(await readFile(f.file(), 'utf8')).toBe(active)
    await f.log.append({ runId: 'run-1', type: 'run.completed', payload: {} })
    expect(await f.log.compactTerminalRuns()).toBe(1)
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0 })
    expect(await f.log.compactTerminalRuns()).toBe(0)
    expect(await f.log.compactTerminalRun('run-1')).toBe(0)
    f.database.exec('UPDATE run_event_maintenance SET compaction_version = 0')
    expect(await f.log.compactTerminalRuns()).toBe(0)
    expect(maintenance(f.database)).toMatchObject({ compaction_version: 1, compaction_pending: 0 })
    f.database.exec('UPDATE run_event_maintenance SET projection_version = 0')
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, rebuilt: 1 })
    expect((await f.log.read('run-1')).map(event => event.sequence)).toEqual([1, 3])
    expect(await f.log.append({ runId: 'run-1', type: 'audit.next', payload: {} })).toMatchObject({ sequence: 4 })
  })
})

async function fixture(callbacks: RunEventLogCallbacks = {}, legacy = false): Promise<MaintenanceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'lexora-event-maintenance-'))
  const databasePath = join(root, 'buddy.sqlite3')
  const database = legacy ? new DatabaseSync(databasePath) : openBuddyDatabase({ databasePath })
  if (legacy) {
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 38))
      database.exec(migration.sql)
    database.exec('PRAGMA user_version = 38')
  }
  database.exec(`
    INSERT INTO conversations (id, created_at, updated_at) VALUES ('conversation-1', '${NOW}', '${NOW}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch-1', 'conversation-1', '${NOW}');
  `)
  const create = (database: DatabaseSync) => createRunEventLog({ database, conversationsDirectory: join(root, 'conversations'), ...callbacks })
  const f = {
    root,
    database,
    log: create(database),
    addRun(runId: string) {
      f.database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
        VALUES (?, 'conversation-1', 'branch-1', 'user-1', 'fixture', 'fixture', 'chat', 'running', ?)`).run(runId, NOW)
    },
    file(runId = 'run-1') {
      return join(root, 'conversations', 'conversation-1', 'events', `${runId}.jsonl`)
    },
    async reopen() {
      await f.log.close()
      f.database.close()
      f.database = openBuddyDatabase({ databasePath })
      f.log = create(f.database)
    },
  }
  f.addRun('run-1')
  fixtures.push(f)
  return f
}

async function seedTerminal(f: MaintenanceFixture, runId = 'run-1') {
  await f.log.appendBatch([
    { runId, type: 'future.audit', payload: { retained: true } },
    { runId, type: 'run.progress', payload: {} },
    { runId, type: 'run.completed', payload: {} },
  ])
}

function maintenance(database: DatabaseSync, runId = 'run-1') {
  return database.prepare('SELECT * FROM run_event_maintenance WHERE run_id = ?').get(runId)
}
