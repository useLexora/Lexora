import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { PreparedRunCommandService } from '../../chat/PreparedRunCommandService'
import { SqliteRunEventLog } from '../../events/SqliteRunEventLog'
import { sqliteRunFixtureTime as now, seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createApprovalRepository } from '../../storage/approvalRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createUsageRepository } from '../../storage/usageRepository'
import { recoverSqliteRuns } from '../recoverSqliteRuns'

const databases: DatabaseSync[] = []
const directories: string[] = []
const logs: SqliteRunEventLog[] = []

afterEach(async () => {
  for (const log of logs.splice(0))
    await log.close()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture(ready = true) {
  const root = mkdtempSync(join(tmpdir(), 'lexora-sqlite-recovery-'))
  directories.push(root)
  const databasePath = join(root, 'candidate.sqlite3')
  const open = () => {
    const database = openBuddyMigrationCandidate({ databasePath })
    databases.push(database)
    return database
  }
  const database = open()
  if (ready)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const conversationsDirectory = join(root, 'conversations')
  return { root, database, open, conversationsDirectory, recover: (database: DatabaseSync) => recoverSqliteRuns({ database, conversationsDirectory }) }
}

function eventLog(database: DatabaseSync) {
  const log = new SqliteRunEventLog({ database })
  logs.push(log)
  return log
}

function seedQueue(database: DatabaseSync, id: string, state: string) {
  database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
    VALUES (?, 'task-1', 'branch-task-1', ?, 'fixture', ?, ?, ?)`).run(id, `request-${id}`, JSON.stringify({ prompt: 'Keep queued input', attachmentIds: ['retained-file'] }), state, now)
}

function approval(id: string) {
  return {
    runId: 'run-1',
    type: 'approval.requested',
    createdAt: now,
    payload: {
      id,
      runId: 'run-1',
      toolCallId: `tool-${id}`,
      kind: 'shell',
      status: 'pending',
      summary: 'Fixture approval',
      payload: { card: 'shell', toolName: 'bash', command: 'fixture', allowForTurn: false },
      createdAt: now,
      resolvedAt: null,
    },
  }
}

function accept(database: DatabaseSync) {
  const drafts = createComposerDraftRepository(database)
  drafts.open({
    draftId: 'draft-1',
    initialContent: createBuddyUserContent('Keep input'),
    initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
    initialModelSelection: { modelId: 'fixture', providerId: 'fixture', reasoning: null, serviceTier: null },
    now,
    scope: { kind: 'global' },
  })
  const owner = new PreparedRunCommandService({ database, sourceInstanceId: 'instance-1' })
  const command = {
    dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation),
    actorId: 'desktop-local',
    commandId: 'command-1',
    fingerprintVersion: 1,
    fingerprint: 'fixture-intent',
  }
  const input = {
    attachmentBindings: [],
    branchId: 'branch-task-1',
    conversationId: 'task-1',
    createdAt: now,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    draft: { draftId: 'draft-1', expectedRevision: 0 },
    model: 'fixture',
    spaceId: null,
    provider: 'fixture',
    runInput: { attachmentIds: [], contextItems: [], prompt: 'Keep input', reasoning: null, serviceTier: null },
    runId: 'run-1',
    title: 'Fixture',
    userMessageContent: { text: 'Keep input' },
    userMessageId: 'input-run-1',
  }
  const { receipt } = owner.start(command, input)
  owner.dispose()
  return { receipt, command, input }
}

function piSession(f: ReturnType<typeof fixture>, runId: string, compact: boolean) {
  const directory = join(f.conversationsDirectory, 'task-1', 'session', 'branch-task-1')
  mkdirSync(directory, { recursive: true })
  const manager = SessionManager.create(f.root, directory)
  const firstKeptEntryId = manager.appendMessage({ role: 'user', content: 'Recent context', timestamp: Date.now() })
  const usage: Usage = { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }
  const assistant: AssistantMessage = { api: 'anthropic-messages', role: 'assistant', content: [{ type: 'text', text: 'Pi-only answer' }], model: 'fixture', provider: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage }
  manager.appendMessage(assistant)
  if (compact)
    manager.appendCompaction('Pi-only private summary', firstKeptEntryId, 1400, undefined, false, usage)
  const file = manager.getSessionFile()!
  f.database.prepare('UPDATE runs SET pi_session_file = ?, purpose = ? WHERE id = ?').run(file, compact ? 'conversation.compaction' : 'chat', runId)
  return { file, bytes: readFileSync(file), firstKeptEntryId }
}

describe('sqlite run restart recovery', () => {
  it('closes interrupted runs and approvals, pauses queues, and keeps original receipts and independent files after reopen', async () => {
    const f = fixture()
    const accepted = accept(f.database)
    seedSqliteRun(f.database, 'run-queued')
    seedSqliteRun(f.database, 'run-terminal')
    const events = eventLog(f.database)
    await events.append({ runId: 'run-terminal', type: 'run.completed', payload: {}, createdAt: now })
    const terminal = createRunRepository(f.database).findById('run-terminal')
    await events.appendBatch([
      { runId: 'run-1', type: 'run.started', payload: {}, createdAt: now },
      ...Array.from({ length: 602 }, (_, index) => ({ runId: 'run-1', type: 'message.delta', payload: { messageId: 'partial-1', delta: `${index},` }, createdAt: new Date(Date.parse(now) - index).toISOString() })),
      { runId: 'run-1', type: 'tool.started', payload: { toolCallId: 'unknown-effect', toolName: 'bash' }, createdAt: now },
      { runId: 'run-1', type: 'future.fact', payload: { retained: true }, createdAt: now },
      approval('pending-1'),
      approval('approved-1'),
      { runId: 'run-1', type: 'approval.resolved', payload: { id: 'approved-1', status: 'approved', resolvedAt: now }, createdAt: now },
    ])
    for (const state of ['waiting', 'paused', 'sent', 'cancelled'])
      seedQueue(f.database, `queue-${state}`, state)
    const beforeQueues = f.database.prepare('SELECT * FROM chat_queue ORDER BY id').all()
    const sourceDirectory = join(f.conversationsDirectory, 'task-1', 'events')
    mkdirSync(sourceDirectory, { recursive: true })
    const legacy = join(sourceDirectory, 'run-1.jsonl')
    writeFileSync(legacy, '{"type":"run.completed","runId":"run-1","sequence":999}\n{broken tail')
    const legacyBytes = readFileSync(legacy)
    const pi = piSession(f, 'run-1', false)
    const externalResult = join(f.root, 'external-result.txt')
    writeFileSync(externalResult, 'Previously performed effect; outcome unrecorded')
    const originalDraft = createComposerDraftRepository(f.database).findById('draft-1')
    f.database.exec(`CREATE TRIGGER reject_terminal_rewrite BEFORE UPDATE OF status ON runs
      WHEN OLD.status IN ('completed', 'failed', 'cancelled') BEGIN SELECT RAISE(ABORT, 'terminal already projected'); END;`)
    await events.close()
    f.database.close()

    const database = f.open()
    expect(await f.recover(database)).toBe(2)
    const recovered = eventLog(database)
    expect(createRunRepository(database).findById('run-1')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(createRunRepository(database).findById('run-queued')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(createRunRepository(database).findById('run-terminal')).toEqual(terminal)
    expect(createConversationRepository(database).findMessageById('partial-1')?.content).toEqual({ state: 'interrupted', truncated: false, text: Array.from({ length: 602 }, (_, index) => `${index},`).join('') })
    expect(createApprovalRepository(database).findById('pending-1')?.status).toBe('cancelled')
    expect(createApprovalRepository(database).findById('approved-1')?.status).toBe('approved')
    expect(database.prepare('SELECT * FROM chat_queue ORDER BY id').all()).toEqual(beforeQueues.map(row => row.state === 'waiting' ? { ...row, state: 'paused', revision: Number(row.revision) + 1 } : row))
    expect(createComposerDraftRepository(database).findById('draft-1')).toEqual(originalDraft)
    const history = await recovered.read('run-1')
    expect(history.filter(event => event.type === 'message.delta')).toEqual([])
    expect(history.filter(event => event.type === 'tool.started')).toHaveLength(1)
    expect(history.filter(event => event.type === 'tool.completed')).toEqual([])
    expect(history.find(event => event.type === 'future.fact')?.payload).toEqual({ retained: true })
    const owner = new PreparedRunCommandService({ database, sourceInstanceId: 'instance-2' })
    expect(owner.find(accepted.command)).toEqual(accepted.receipt)
    expect(owner.start(accepted.command, accepted.input)).toEqual({ created: false, receipt: accepted.receipt })
    owner.dispose()
    expect(await f.recover(database)).toBe(0)
    expect(await recovered.read('run-1')).toEqual(history)
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()?.count).toBe(3)
    expect(readFileSync(legacy)).toEqual(legacyBytes)
    expect(readFileSync(pi.file)).toEqual(pi.bytes)
    expect(readFileSync(externalResult, 'utf8')).toBe('Previously performed effect; outcome unrecorded')
    expect(JSON.stringify(history)).not.toContain('Pi-only answer')
  })

  it('rolls back interrupted-message and terminal facts together on failure without SQL-only fallback', async () => {
    const f = fixture()
    seedSqliteRun(f.database, 'run-1')
    const events = eventLog(f.database)
    await events.appendBatch([
      { runId: 'run-1', type: 'run.started', payload: {}, createdAt: now },
      { runId: 'run-1', type: 'message.delta', payload: { messageId: 'partial', delta: 'Keep partial' }, createdAt: now },
    ])
    const before = await events.read('run-1')
    f.database.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON run_events
      WHEN NEW.event_type = 'run.failed' BEGIN SELECT RAISE(ABORT, 'recovery unavailable'); END;`)
    await expect(f.recover(f.database)).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED', operation: 'append', cause: { errcode: 1811 } })
    expect(() => f.database.prepare('SELECT 1')).toThrow('Storage is isolated')
    await events.close()
    f.database.close()
    const reopened = f.open()
    expect(await eventLog(reopened).read('run-1')).toEqual(before)
    expect(createRunRepository(reopened).findById('run-1')).toMatchObject({ status: 'running', errorCode: null })
    expect(createConversationRepository(reopened).findMessageById('partial')).toBeNull()
    expect(reopened.prepare('SELECT next_event_sequence FROM runs').get()?.next_event_sequence).toBe(3)
    reopened.exec('DROP TRIGGER reject_recovery')
    expect(await f.recover(reopened)).toBe(1)
    expect(createConversationRepository(reopened).findMessageById('partial')?.content).toMatchObject({ text: 'Keep partial', state: 'interrupted' })
    expect((await eventLog(reopened).read('run-1')).map(event => event.sequence)).toEqual([1, 3, 4])
  })

  it('resumes partially committed approval cancellation without reviving approved history or dispatching paused queues', async () => {
    const f = fixture()
    seedSqliteRun(f.database, 'run-1')
    const events = eventLog(f.database)
    await events.appendBatch([approval('a'), approval('b')])
    seedQueue(f.database, 'queue-waiting', 'waiting')
    f.database.exec(`CREATE TRIGGER reject_second_cancellation BEFORE INSERT ON run_events
      WHEN NEW.event_type = 'approval.resolved' AND json_extract(NEW.payload_json, '$.id') = 'b'
      BEGIN SELECT RAISE(ABORT, 'approval unavailable'); END;`)
    await expect(f.recover(f.database)).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
    expect(() => f.database.prepare('SELECT 1')).toThrow('Storage is isolated')
    await events.close()
    f.database.close()
    const database = f.open()
    expect(createApprovalRepository(database).findById('a')?.status).toBe('cancelled')
    expect(createApprovalRepository(database).findById('b')?.status).toBe('pending')
    expect(createRunRepository(database).findById('run-1')?.status).toBe('queued')
    expect(database.prepare('SELECT state FROM chat_queue').get()?.state).toBe('paused')
    database.exec('DROP TRIGGER reject_second_cancellation')
    expect(await f.recover(database)).toBe(1)
    expect(createApprovalRepository(database).listPending()).toEqual([])
    expect((await eventLog(database).read('run-1')).filter(event => event.type === 'approval.resolved')).toHaveLength(2)
  })

  it('stops on unreadable authority without replacing it with empty or legacy history', async () => {
    const f = fixture()
    seedSqliteRun(f.database, 'run-1')
    const events = eventLog(f.database)
    await events.append({ runId: 'run-1', type: 'future.fact', payload: {}, createdAt: now })
    f.database.exec('UPDATE run_events SET format_version = 2')
    const before = f.database.prepare('SELECT * FROM run_events').all()
    await expect(f.recover(f.database)).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED', operation: 'read' })
    expect(() => f.database.prepare('SELECT 1')).toThrow('Storage is isolated')
    f.database.close()
    const database = f.open()
    expect(database.prepare('SELECT * FROM run_events').all()).toEqual(before)
    expect(createRunRepository(database).findById('run-1')?.status).toBe('queued')
  })

  it('leaves a pending migration untouched before any recovery mutation', async () => {
    const f = fixture(false)
    seedSqliteRun(f.database, 'run-1')
    seedQueue(f.database, 'queue-waiting', 'waiting')
    await expect(f.recover(f.database)).rejects.toThrow('not ready')
    expect(f.database.prepare('SELECT state FROM chat_queue').get()?.state).toBe('waiting')
    expect(f.database.prepare('SELECT * FROM run_events').all()).toEqual([])
    expect(createRunRepository(f.database).findById('run-1')?.status).toBe('queued')
  })

  it.each([false, true])('recovers committed Pi compaction independently and deduplicates usage across an interrupted finalization (%s)', async (interrupt) => {
    const f = fixture()
    seedSqliteRun(f.database, 'run-1')
    const events = eventLog(f.database)
    await events.append({ runId: 'run-1', type: 'run.started', payload: {}, createdAt: now })
    const pi = piSession(f, 'run-1', true)
    if (interrupt) {
      f.database.exec(`CREATE TRIGGER interrupt_compaction BEFORE INSERT ON run_events
        WHEN NEW.event_type = 'run.completed' BEGIN SELECT RAISE(ABORT, 'finalization unavailable'); END;`)
      await expect(f.recover(f.database)).rejects.toMatchObject({ code: 'EVENT_STORAGE_FAILED' })
      expect(() => f.database.prepare('SELECT 1')).toThrow('Storage is isolated')
    }
    await events.close()
    f.database.close()
    const database = f.open()
    if (interrupt) {
      expect(createRunRepository(database).findById('run-1')?.status).toBe('running')
      expect(createUsageRepository(database).listForRun('run-1')).toHaveLength(1)
      database.exec('DROP TRIGGER interrupt_compaction')
    }
    expect(await f.recover(database)).toBe(1)
    expect(createRunRepository(database).findById('run-1')).toMatchObject({ status: 'completed', errorCode: null })
    const history = await eventLog(database).read('run-1')
    expect(history.map(event => event.type)).toEqual(['run.started', 'context.compaction.completed', 'usage.recorded', 'run.completed'])
    expect(createUsageRepository(database).listForRun('run-1')).toMatchObject([{ sourceEntryId: `compaction:${pi.firstKeptEntryId}`, inputTokens: 20, outputTokens: 5, purpose: 'compaction' }])
    expect(JSON.stringify(history)).not.toContain('Pi-only private summary')
    expect(readFileSync(pi.file)).toEqual(pi.bytes)
    expect(await f.recover(database)).toBe(0)
    expect(await eventLog(database).read('run-1')).toEqual(history)
  })

  it.each(['missing', 'unavailable'] as const)('does not rerun compaction when its Pi evidence is %s', async (kind) => {
    const f = fixture()
    seedSqliteRun(f.database, 'run-1')
    const directory = join(f.conversationsDirectory, 'task-1', 'session', 'branch-task-1')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'session.jsonl')
    if (kind === 'unavailable')
      mkdirSync(file)
    f.database.prepare('UPDATE runs SET purpose = ?, pi_session_file = ?').run('conversation.compaction', file)
    expect(await f.recover(f.database)).toBe(1)
    expect(createRunRepository(f.database).findById('run-1')).toMatchObject({ status: 'failed', errorCode: kind === 'missing' ? 'RUNTIME_RESTARTED' : 'SESSION_STORAGE_UNAVAILABLE' })
    expect((await eventLog(f.database).read('run-1')).map(event => event.type)).toEqual(['run.failed'])
  })
})
