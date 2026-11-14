import type { DatabaseSync } from 'node:sqlite'
import type { AppendBuddyRunEventInput } from '../../../apps/buddy/service/src/events/BuddyRunEvent'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises'
import { BufferedRunEventWriter } from '../../../apps/buddy/service/src/agent/events/BufferedRunEventWriter'
import { SqliteRunEventLog } from '../../../apps/buddy/service/src/events/SqliteRunEventLog'
import { checkpointSqliteStorage } from '../../../apps/buddy/service/src/storage/checkpointSqliteStorage'
import { CommandCommitter } from '../../../apps/buddy/service/src/storage/CommandCommitter'
import { createComposerDraftRepository } from '../../../apps/buddy/service/src/storage/composerDraftRepository'
import { createConversationRepository } from '../../../apps/buddy/service/src/storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../../apps/buddy/service/src/storage/database'
import { guardStorageDatabase } from '../../../apps/buddy/service/src/storage/StorageIsolation'
import { withTransaction } from '../../../apps/buddy/service/src/storage/transaction'
import { createBuddyUserContent } from '../../../apps/buddy/shared/conversation/buddyUserContent'
import { seedSqliteRun } from './storageFixture'

const time = '2026-09-29T00:00:00.000Z'
const executionConfig = { approvalPolicy: 'policy', executionProfile: 'workspace_write' } as const
const modes = ['full-1', 'full-20', 'buffered'] as const
type Mode = typeof modes[number]

function distribution(values: number[]) {
  assert(values.length > 0)
  const sorted = values.toSorted((a, b) => a - b)
  return {
    count: sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
    max: sorted.at(-1)!,
  }
}

function seed(database: DatabaseSync) {
  withTransaction(database, () => {
    const insert = database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      VALUES (?, 'task-1', 'branch-task-1', ?, 'assistant', ?, ?)`)
    for (let run = 0; run < 1000; run++) {
      seedSqliteRun(database, `history-${run}`)
      for (let message = 0; message < 9; message++) {
        insert.run(`history-${run}-${message}`, `history-${run}`, JSON.stringify({ text: 'x'.repeat(256) }), new Date(Date.parse(time) + run * 9 + message).toISOString())
      }
    }
    database.exec('UPDATE runs SET status = \'completed\'')
    seedSqliteRun(database, 'stream-run')
  })
  const drafts = createComposerDraftRepository(database)
  drafts.open({
    draftId: 'draft',
    scope: { kind: 'global' },
    initialContent: createBuddyUserContent('Draft'),
    initialExecutionConfig: executionConfig,
    initialModelSelection: null,
    now: time,
  })
  return { drafts, commands: new CommandCommitter(database), conversations: createConversationRepository(database) }
}

function storageSize(databasePath: string) {
  return {
    database: statSync(databasePath).size,
    wal: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
  }
}

async function sample(root: string, mode: Mode, repetition: number) {
  const directory = join(root, `${mode}-${repetition}`)
  mkdirSync(directory)
  const databasePath = join(directory, 'candidate.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath })
  guardStorageDatabase(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const log = new SqliteRunEventLog({ database })
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  try {
    assert.deepEqual({ ...database.prepare('PRAGMA synchronous').get() }, { synchronous: 2 })
    assert.deepEqual({ ...database.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' })
    const { drafts, commands, conversations } = seed(database)
    const beforeSize = storageSize(databasePath)
    const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
    const commitTimes: number[] = []
    const appendBatch = async (events: readonly AppendBuddyRunEventInput[]) => {
      const started = performance.now()
      const result = await log.appendBatch(events)
      commitTimes.push(performance.now() - started)
      return result
    }
    const buffered = new BufferedRunEventWriter({ appendBatch }, 'stream-run', () => time)
    const batchSize = mode === 'full-1' ? 1 : 20
    histogram.enable()
    await delay(10)
    const cpuBefore = process.cpuUsage()
    const started = performance.now()
    let peakRss = process.memoryUsage().rss
    for (let index = 0; index < 4000; index += batchSize) {
      const events = Array.from({ length: batchSize }, () => ({
        runId: 'stream-run',
        type: 'message.delta' as const,
        payload: { messageId: 'stream', delta: 's'.repeat(128) },
        createdAt: time,
      }))
      if (mode === 'buffered')
        buffered.appendBatch(events)
      else
        await appendBatch(events)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      await yieldLoop()
    }
    await buffered.drain()
    const elapsedMs = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)
    await delay(10)
    histogram.disable()
    const eventLoopMs = { p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 }
    const facts = await log.read('stream-run')
    assert.equal(facts.map(event => (event.payload as { delta: string }).delta).join(''), 's'.repeat(4000 * 128))
    const queries: Record<string, number[]> = { legacyOffset: [], messageTail: [], messageOld: [], eventOld: [] }
    const reads = {
      legacyOffset: () => database.prepare('SELECT * FROM messages WHERE conversation_id = \'task-1\' AND branch_id = \'branch-task-1\' ORDER BY created_at DESC LIMIT 50 OFFSET 9000').all(),
      messageTail: () => conversations.listMessagePage('task-1', 'branch-task-1', { limit: 50 }).items,
      messageOld: () => conversations.listMessagePage('task-1', 'branch-task-1', { limit: 50, beforeMessageId: 'history-100-0' }).items,
      eventOld: () => log.list('stream-run', { limit: 50, afterSequence: 0 }),
    }
    for (let index = 0; index < 200; index++) {
      for (const [name, read] of Object.entries(reads)) {
        const begin = performance.now()
        const rows = await read()
        queries[name]!.push(performance.now() - begin)
        assert.equal(rows.length, 50)
      }
      await yieldLoop()
    }
    const terminalStart = performance.now()
    await log.appendBatch([
      { runId: 'stream-run', type: 'message.completed', payload: {
        messageId: 'stream',
        role: 'assistant',
        content: { text: 's'.repeat(4000 * 128) },
        stopReason: 'completed',
      }, createdAt: time },
      { runId: 'stream-run', type: 'run.completed', payload: null, createdAt: time },
    ])
    const terminalMs = performance.now() - terminalStart
    const compactStart = performance.now()
    const removedEvents = await log.compactTerminalRun('stream-run')
    const compactionMs = performance.now() - compactStart
    assert.equal(removedEvents, facts.length)
    assert.equal((await log.read('stream-run')).length, 2)
    assert.equal(database.prepare('SELECT next_event_sequence FROM runs WHERE id = \'stream-run\'').get()!.next_event_sequence, facts.length + 3)
    const draftTimes: number[] = []
    histogram.reset()
    histogram.enable()
    await delay(10)
    for (let revision = 0; revision < 1000; revision++) {
      const begin = performance.now()
      const result = commands.accept({
        dataGeneration,
        actorId: 'desktop-local',
        commandId: `save-${revision}`,
        method: 'draft.save',
        fingerprintVersion: 1,
        fingerprint: `draft-${revision}`,
        sourceInstanceId: 'cost-fixture',
      }, () => {
        const draft = drafts.save({ draftId: 'draft', expectedRevision: revision, content: createBuddyUserContent('d'.repeat(512)), executionConfig, modelSelection: null, now: time })
        return { target: { draftId: draft.draftId }, result: { revision: draft.revision } }
      })
      draftTimes.push(performance.now() - begin)
      assert.equal(result.receipt.result.revision, revision + 1)
      await yieldLoop()
    }
    await delay(10)
    histogram.disable()
    const draftEventLoopMs = { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 }
    assert.equal(drafts.findById('draft')?.revision, 1000)
    assert.equal(database.prepare('SELECT count(*) AS count FROM command_receipts').get()!.count, 1000)
    const beforeCheckpoint = storageSize(databasePath)
    const checkpointStart = performance.now()
    const checkpoint = { ...checkpointSqliteStorage(database), elapsedMs: performance.now() - checkpointStart }
    const afterCheckpoint = storageSize(databasePath)
    const result = {
      mode,
      repetition,
      historyRuns: 1000,
      historyMessages: 10000,
      inputEvents: 4000,
      inputCharacters: 128,
      persistedEvents: facts.length,
      elapsedMs,
      cpu,
      peakRss,
      commitMs: distribution(commitTimes),
      draftCommitMs: distribution(draftTimes),
      eventLoopMs,
      draftEventLoopMs,
      queriesMs: Object.fromEntries(Object.entries(queries).map(([name, values]) => [name, distribution(values)])),
      beforeSize,
      beforeCheckpoint,
      afterCheckpoint,
      checkpoint,
      terminalMs,
      compactionMs,
      removedEvents,
      sqlite: database.prepare('SELECT sqlite_version() AS version').get()!.version,
    }
    writeFileSync(join(root, `${mode}-${repetition}.json`), `${JSON.stringify(result, null, 2)}\n`)
    assert.equal(checkpoint.busy, 0)
    assert.equal(afterCheckpoint.wal, 0)
    for (const p99 of [result.commitMs.p99, result.draftCommitMs.p99, eventLoopMs.p99, draftEventLoopMs.p99, ...Object.values(result.queriesMs).map(query => query.p99)])
      assert(p99 <= 25, `Storage cost P99 ${p99.toFixed(2)}ms exceeds 25ms`)
    return result
  }
  finally {
    histogram.disable()
    try {
      await log.close()
    }
    finally {
      database.close()
      rmSync(directory, { recursive: true })
    }
  }
}

export async function runStorageDurability(root: string, bundleSha256: string) {
  const samples: Awaited<ReturnType<typeof sample>>[] = []
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, bundleSha256, samples, passed: false }
  try {
    for (let repetition = 1; repetition <= 3; repetition++) {
      for (const mode of modes) {
        const result = await sample(root, mode, repetition)
        samples.push(result)
        process.stdout.write(`${mode} ${repetition}/3: commit P99 ${result.commitMs.p99.toFixed(2)}ms, loop P99 ${result.eventLoopMs.p99.toFixed(2)}ms, old page P99 ${result.queriesMs.messageOld!.p99.toFixed(2)}ms\n`)
      }
    }
    report.passed = true
  }
  finally {
    writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}
