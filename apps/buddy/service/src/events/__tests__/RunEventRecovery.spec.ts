import type { DatabaseSync } from 'node:sqlite'
import type { AppendBuddyRunEventInput, BuddyRunEvent } from '../BuddyRunEvent'
import type { RunEventLogCallbacks } from '../RunEventLog'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createRunEventLog } from '../createRunEventLog'
import { RunEventProjector } from '../RunEventProjector'
import { RunEventQueries } from '../RunEventQueries'
import { RUN_EVENT_PROJECTION_VERSION } from '../RunEventRecovery'
import { RunEventStore } from '../RunEventStore'

const NOW = '2026-10-04T00:00:00.000Z'
const databases = new Set<DatabaseSync>()
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases)
    database.close()
  databases.clear()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('startup run event recovery', () => {
  it.skipIf(process.env.LEXORA_RUN_RECOVERY_BENCHMARK !== '1')('measures ten warmed full/skip recovery pairs on isolated persistent data', async () => {
    const f = await fixture(true)
    const eventStore = store(f)
    const runCount = 60
    const eventsPerRun = 80
    for (let index = 0; index < runCount; index++) {
      const runId = index === 0 ? 'run-1' : `benchmark-${index}`
      if (index > 0) {
        f.database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
          SELECT ?, conversation_id, branch_id, triggering_message_id, provider, model, purpose, 'running', started_at FROM runs WHERE id = 'run-1'`).run(runId)
      }
      const events: BuddyRunEvent[] = Array.from({ length: eventsPerRun }, (_, position) => ({
        runId,
        sequence: position + 1,
        type: position === eventsPerRun - 1 ? 'run.completed' : 'message.completed',
        payload: position === eventsPerRun - 1
          ? {}
          : {
              messageId: `${runId}-message-${position}`,
              role: 'assistant',
              content: { text: 'fixture'.repeat(128) },
              stopReason: 'completed',
            },
        createdAt: NOW,
      }))
      await eventStore.append(events)
    }
    await f.log.recoverAll({ force: true })
    const full: number[] = []
    const skipped: number[] = []
    for (let sample = 0; sample < 10; sample++) {
      await f.restart()
      const rebuilt = await f.log.recoverAll({ force: true })
      expect(rebuilt.rebuilt).toBe(runCount)
      full.push(rebuilt.durationMs)
      await f.restart()
      const reused = await f.log.recoverAll()
      expect(reused).toMatchObject({ skipped: runCount, rebuilt: 0, events: 0 })
      skipped.push(reused.durationMs)
    }
    const quantiles = (values: number[]) => {
      const sorted = values.toSorted((a, b) => a - b)
      return { medianMs: (sorted[4]! + sorted[5]!) / 2, p90Ms: sorted[8]! }
    }
    const fullSummary = quantiles(full)
    const skippedSummary = quantiles(skipped)
    process.stdout.write(`${JSON.stringify({
      event: 'run.recovery.benchmark',
      samples: 10,
      warmed: true,
      runs: runCount,
      eventsPerRun,
      full: fullSummary,
      skipped: skippedSummary,
      reductionPercent: (1 - skippedSummary.medianMs / fullSummary.medianMs) * 100,
    })}\n`)
    // Timing is diagnostic, not a flaky unit-test pass threshold.
    const before = projection(f.database)
    await f.log.recoverAll({ force: true })
    expect(projection(f.database)).toEqual(before)
  }, 60_000)

  it('rebuilds old data once, then skips stable history across database reopen without reading or projecting', async () => {
    const f = await fixture(true)
    await seedHistory(f.log)
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, rebuilt: 1, skipped: 0, failed: 0 })
    const before = projection(f.database)
    await f.reopen()
    const read = vi.spyOn(RunEventStore.prototype, 'readAndRepair')
    const rebuild = vi.spyOn(RunEventProjector.prototype, 'rebuild')
    const lookup = vi.spyOn(RunEventQueries.prototype, 'findConversationId')
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 1, rebuilt: 0, skipped: 1, events: 0 })
    expect(read).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(projection(f.database)).toEqual(before)
    expect(await f.log.append({ runId: 'run-1', type: 'audit.after_restart', payload: {} })).toMatchObject({ sequence: 6 })
    expect(read).not.toHaveBeenCalled()
    expect(checkpoint(f.database)).toBeUndefined()
  })

  it('only rebuilds the changed run and leaves other stable history alone', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    f.database.exec(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      SELECT 'run-2', conversation_id, branch_id, triggering_message_id, provider, model, purpose, 'running', started_at FROM runs WHERE id = 'run-1'`)
    await f.log.append({ runId: 'run-2', type: 'run.completed', payload: {} })
    await f.log.recoverAll()
    await f.log.append({ runId: 'run-1', type: 'audit.new', payload: {} })
    const read = vi.spyOn(RunEventStore.prototype, 'readAndRepair')
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 2, skipped: 1, rebuilt: 1 })
    expect(read.mock.calls.map(call => call[0])).toEqual(['run-1'])
    expect(await f.log.list('run-1')).toHaveLength(6)
  })

  it('forces full validation without changing messages, approvals, usage or event results', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    const before = projection(f.database)
    const read = vi.spyOn(RunEventStore.prototype, 'readAndRepair')
    expect(await f.log.recoverAll({ force: true })).toMatchObject({ skipped: 0, rebuilt: 1, events: 5 })
    expect(await f.log.replay('run-1')).toBe(5)
    expect(await f.log.replayAll()).toBe(5)
    expect(read).toHaveBeenCalledTimes(3)
    expect(projection(f.database)).toEqual(before)
  })

  it('does not mutate the log when checkpoint invalidation fails', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    const before = await readFile(f.eventFile, 'utf8')
    f.database.exec(`CREATE TRIGGER reject_invalidation BEFORE DELETE ON run_event_checkpoints
      BEGIN SELECT RAISE(ABORT, 'invalidation failed'); END;`)
    const append = vi.spyOn(RunEventStore.prototype, 'append')
    await expect(f.log.append({ runId: 'run-1', type: 'audit.new', payload: {} })).rejects.toMatchObject({
      code: 'EVENT_PROJECTION_FAILED',
      commitState: 'not_applicable',
    })
    expect(append).not.toHaveBeenCalled()
    expect(await readFile(f.eventFile, 'utf8')).toBe(before)
    expect(checkpoint(f.database)).toBeDefined()
    expect(f.log.state).toBe('failed')
  })

  it('rolls back projection and checkpoint together when checkpoint publication fails', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    f.database.exec(`UPDATE messages SET content_json = '{"text":"damaged"}' WHERE id = 'answer-1';
      CREATE TRIGGER reject_checkpoint BEFORE INSERT ON run_event_checkpoints
      BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END;`)
    const damaged = projection(f.database)
    await expect(f.log.recoverAll()).rejects.toMatchObject({ code: 'EVENT_PROJECTION_FAILED' })
    expect(checkpoint(f.database)).toBeUndefined()
    expect(projection(f.database)).toEqual(damaged)
    f.database.exec('DROP TRIGGER reject_checkpoint')
    await f.restart()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages WHERE id = \'answer-1\'').get()).toEqual({ content_json: '{"text":"answer"}' })
  })

  it('recovers the log-durable / projection-uncommitted crash window', async () => {
    const f = await fixture(true)
    await seedHistory(f.log)
    await f.log.recoverAll()
    new RunEventProjector(f.database).invalidateCheckpoint('run-1')
    await store(f).append([{ runId: 'run-1', sequence: 6, type: 'audit.crash', payload: {}, createdAt: NOW }])
    expect(await f.log.list('run-1')).toHaveLength(5)
    await f.reopen()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0, events: 6 })
    expect(await f.log.list('run-1')).toHaveLength(6)
    const before = projection(f.database)
    await f.log.recoverAll({ force: true })
    expect(projection(f.database)).toEqual(before)
  })

  it('safely rebuilds after invalidation even if the process stopped before modifying the log', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    new RunEventProjector(f.database).invalidateCheckpoint('run-1')
    await f.restart()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
  })

  it.each([
    'DELETE FROM run_events WHERE run_id = \'run-1\' AND sequence = 2',
    'DELETE FROM messages WHERE id = \'answer-1\'',
    'UPDATE messages SET content_json = \'{"text":"damaged"}\' WHERE id = \'answer-1\'',
    'DELETE FROM approvals WHERE id = \'approval-1\'',
    'UPDATE approvals SET status = \'denied\' WHERE id = \'approval-1\'',
    'DELETE FROM usage_records WHERE id = \'usage-1\'',
    'UPDATE usage_records SET total_cost = 99 WHERE id = \'usage-1\'',
    'UPDATE runs SET completed_at = \'2026-10-01T00:00:00.000Z\' WHERE id = \'run-1\'',
  ])('invalidates direct database projection writes and restores the supported projection: %s', async (sql) => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    const before = projection(f.database)
    f.database.exec(sql)
    expect(checkpoint(f.database)).toBeUndefined()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
    expect(projection(f.database)).toEqual(before)
  })

  it('does not reread stable terminal history for a retained noncompactable tool update', async () => {
    const f = await fixture()
    await f.log.appendBatch([
      { runId: 'run-1', type: 'tool.updated', payload: { toolCallId: 'tool-1' } },
      { runId: 'run-1', type: 'run.completed', payload: {} },
    ])
    await f.log.recoverAll()
    await f.restart()
    const read = vi.spyOn(RunEventStore.prototype, 'readAndRepair')
    expect(await f.log.recoverAll()).toMatchObject({ skipped: 1, rebuilt: 0 })
    expect(await f.log.compactTerminalRuns()).toBe(0)
    expect(read).not.toHaveBeenCalled()
    // An explicit maintenance request remains a full inspection.
    expect(await f.log.compactTerminalRun('run-1')).toBe(0)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('invalidates compaction, then certifies retained sequences without renumbering', async () => {
    const f = await fixture()
    await f.log.appendBatch([
      { runId: 'run-1', type: 'run.started', payload: {} },
      { runId: 'run-1', type: 'run.progress', payload: {} },
      { runId: 'run-1', type: 'run.completed', payload: {} },
    ])
    await f.log.recoverAll()
    expect(checkpoint(f.database)).toBeUndefined()
    expect(await f.log.compactTerminalRuns()).toBe(1)
    await f.restart()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, events: 2 })
    await f.restart()
    expect(await f.log.recoverAll()).toMatchObject({ skipped: 1 })
    const read = vi.spyOn(RunEventStore.prototype, 'readAndRepair')
    expect(await f.log.append({ runId: 'run-1', type: 'audit.next', payload: {} })).toMatchObject({ sequence: 4 })
    expect(read).not.toHaveBeenCalled()
  })

  it('detects replacement even when the final sequence and file size have not changed', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    const content = await readFile(f.eventFile, 'utf8')
    const replaced = content.replace('"text":"answer"', '"text":"edited"')
    expect(replaced.length).toBe(content.length)
    const replacement = `${f.eventFile}.replacement`
    await writeFile(replacement, replaced)
    await rm(f.eventFile)
    await rename(replacement, f.eventFile)
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages WHERE id = \'answer-1\'').get()).toEqual({ content_json: '{"text":"edited"}' })
  })

  it('quarantines a torn tail without changing evidence across repeated recovery', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    await appendFile(f.eventFile, '{"runId":"run-1"')
    const damaged = await readFile(f.eventFile, 'utf8')
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 0, skipped: 0, failed: 1 })
    expect(checkpoint(f.database)).toBeUndefined()
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 0, failed: 1 })
    expect(await readFile(f.eventFile, 'utf8')).toBe(damaged)
  })

  it.each([
    'UPDATE run_event_checkpoints SET last_sequence = last_sequence + 100',
    'UPDATE run_event_checkpoints SET projection_version = projection_version + 1',
    'DELETE FROM run_event_checkpoints',
  ])('rebuilds an incompatible or missing checkpoint: %s', async (sql) => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    f.database.exec(sql)
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
    expect(checkpoint(f.database)).toMatchObject({ last_sequence: 5, projection_version: RUN_EVENT_PROJECTION_VERSION })
  })

  it('does not skip a running task even with an externally inserted checkpoint', async () => {
    const f = await fixture()
    await f.log.append({ runId: 'run-1', type: 'run.started', payload: {} })
    const fingerprint = await store(f).fingerprint('run-1')
    f.database.prepare('INSERT INTO run_event_checkpoints VALUES (?, ?, ?, ?)').run('run-1', 1, RUN_EVENT_PROJECTION_VERSION, fingerprint)
    expect(await f.log.recoverAll()).toMatchObject({ rebuilt: 1, skipped: 0 })
    expect(checkpoint(f.database)).toBeUndefined()
  })

  it('quarantines missing logs with existing projections without erasing data or inventing unknown runs', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    const before = projection(f.database)
    await rm(f.eventFile)
    await writeFile(join(f.conversationsDirectory, 'conversation-1', 'events', 'unknown-run.jsonl'), '{broken}\n')
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0, skipped: 0, rebuilt: 0, failed: 1 })
    expect(() => f.log.assertConversationWritable('conversation-1')).not.toThrow()
    expect(() => f.log.assertRunWritable('run-1')).toThrow(expect.objectContaining({ code: 'EVENT_LOG_CORRUPTED' }))
    expect(checkpoint(f.database)).toBeUndefined()
    expect(projection(f.database)).toEqual(before)
    expect(f.database.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'run-1' }])
  })

  it('does not revive a soft-deleted conversation and cascades checkpoints on physical run deletion', async () => {
    const f = await fixture()
    await seedHistory(f.log)
    await f.log.recoverAll()
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(NOW, 'conversation-1')
    expect(await f.log.recoverAll()).toMatchObject({ skipped: 1 })
    expect(f.database.prepare('SELECT deleted_at FROM conversations').get()).toEqual({ deleted_at: NOW })
    f.database.exec('DELETE FROM runs WHERE id = \'run-1\'')
    expect(checkpoint(f.database)).toBeUndefined()
    expect(await f.log.recoverAll()).toMatchObject({ scanned: 0 })
  })

  it('reports failures and does not hide corrupt log errors behind a checkpoint', async () => {
    const onRecovery = vi.fn()
    const f = await fixture(false, { onRecovery })
    await seedHistory(f.log)
    await f.log.recoverAll()
    await appendFile(f.eventFile, '{broken}\n')
    await expect(f.log.recoverAll()).resolves.toMatchObject({
      failed: 1,
      failures: [{ code: 'EVENT_LOG_CORRUPTED', conversationId: 'conversation-1', runId: 'run-1' }],
    })
    expect(onRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ failed: 1, skipped: 0 }))
    expect(f.log.state).toBe('open')
    expect(checkpoint(f.database)).toBeUndefined()
  })

  it('ignores diagnostic observer exceptions and preserves failure on invalid file paths', async () => {
    const f = await fixture(false, { onRecovery: () => {
      throw new Error('observer failed')
    } })
    expect(await f.log.recoverAll()).toMatchObject({ failed: 0 })
    await mkdir(f.eventFile, { recursive: true })
    await expect(f.log.recoverAll()).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED', stage: 'stat' })
  })
})

async function fixture(persistent = false, callbacks: RunEventLogCallbacks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-event-recovery-'))
  directories.push(root)
  const databasePath = persistent ? join(root, 'buddy.sqlite3') : ':memory:'
  const database = openBuddyDatabase({ databasePath })
  databases.add(database)
  database.exec(`
    INSERT INTO conversations (id, created_at, updated_at) VALUES ('conversation-1', '${NOW}', '${NOW}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch-1', 'conversation-1', '${NOW}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run-1', 'conversation-1', 'branch-1', 'user-1', 'fixture', 'fixture', 'chat', 'running', '${NOW}');
  `)
  const conversationsDirectory = join(root, 'conversations')
  const create = (db: DatabaseSync) => createRunEventLog({ conversationsDirectory, database: db, ...callbacks })
  const f = {
    root,
    database,
    conversationsDirectory,
    eventFile: join(conversationsDirectory, 'conversation-1', 'events', 'run-1.jsonl'),
    log: create(database),
    async restart() {
      await f.log.close()
      f.log = create(f.database)
    },
    async reopen() {
      await f.log.close()
      f.database.close()
      databases.delete(f.database)
      f.database = openBuddyDatabase({ databasePath })
      databases.add(f.database)
      f.log = create(f.database)
    },
  }
  return f
}

function store(f: Awaited<ReturnType<typeof fixture>>) {
  return new RunEventStore({ conversationsDirectory: f.conversationsDirectory, resolveConversationId: () => 'conversation-1' })
}

function checkpoint(database: DatabaseSync) {
  return database.prepare('SELECT * FROM run_event_checkpoints WHERE run_id = \'run-1\'').get()
}

function projection(database: DatabaseSync) {
  return {
    runs: database.prepare('SELECT * FROM runs ORDER BY id').all(),
    messages: database.prepare('SELECT rowid, * FROM messages ORDER BY id').all(),
    approvals: database.prepare('SELECT * FROM approvals ORDER BY id').all(),
    usage: database.prepare('SELECT * FROM usage_records ORDER BY id').all(),
    events: database.prepare('SELECT * FROM run_events ORDER BY run_id, sequence').all(),
  }
}

async function seedHistory(log: ReturnType<typeof createRunEventLog>) {
  const events: AppendBuddyRunEventInput[] = [
    {
      runId: 'run-1',
      type: 'message.completed',
      createdAt: NOW,
      payload: { messageId: 'answer-1', role: 'assistant', content: { text: 'answer' }, stopReason: 'completed' },
    },
    {
      runId: 'run-1',
      type: 'approval.requested',
      createdAt: NOW,
      payload: {
        id: 'approval-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        kind: 'read',
        status: 'pending',
        summary: 'Read fixture',
        createdAt: NOW,
        resolvedAt: null,
        payload: { card: 'paths', access: 'read', grant: null, toolName: 'read', targets: [{ path: '/fixture.txt', zone: 'workspace' }] },
      },
    },
    { runId: 'run-1', type: 'approval.resolved', createdAt: NOW, payload: { id: 'approval-1', status: 'approved', resolvedAt: NOW } },
    {
      runId: 'run-1',
      type: 'usage.recorded',
      createdAt: NOW,
      payload: {
        usageRecordId: 'usage-1',
        sourceEntryId: 'entry-1',
        provider: 'fixture',
        model: 'fixture',
        purpose: 'turn',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        totalTokens: 15,
        inputCost: 0.01,
        outputCost: 0.02,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        totalCost: 0.03,
      },
    },
    { runId: 'run-1', type: 'run.completed', createdAt: NOW, payload: {} },
  ]
  await log.appendBatch(events)
}
