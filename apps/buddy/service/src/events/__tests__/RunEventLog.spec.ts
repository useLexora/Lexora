import type { DatabaseSync } from 'node:sqlite'
import type { RunEventLogCallbacks } from '../RunEventLog'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contextPanelRpc } from '../../../../shared/context-panel/contextPanel'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { registerContextPanelRpc } from '../../context-panel/registerContextPanelRpc'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createRunEventLog } from '../createRunEventLog'
import { RunEventProjector } from '../RunEventProjector'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('runEventLog', () => {
  it('persists desktop operations after completion and replays them without creating model messages', async () => {
    const fixture = await createFixture()
    await fixture.log.append({ runId: 'run-1', type: 'run.completed', payload: {} })
    let recordOperation: ((input: unknown) => unknown) | undefined
    const dispose = registerContextPanelRpc({
      rpc: { onRequest: (method, handler) => {
        expect(method).toBe(contextPanelRpc.recordOperation)
        recordOperation = handler
        return () => {}
      } },
      runs: createRunRepository(fixture.database),
      events: fixture.log,
    })
    const operation = { action: 'close', actor: 'user', source: { runId: 'run-1', conversationId: 'conversation-1' }, createdAt: '2026-09-17T00:00:00.000Z' }
    await expect(recordOperation!(operation)).resolves.toEqual({ recorded: true })
    await expect(recordOperation!({ ...operation, source: { ...operation.source, conversationId: 'other' } })).resolves.toEqual({ recorded: false })
    await fixture.log.compactTerminalRun('run-1')
    await fixture.log.replay('run-1')
    expect((await fixture.log.list('run-1')).at(-1)).toMatchObject({ type: 'desktop.panel.changed', payload: { action: 'close', actor: 'user' } })
    expect(fixture.database.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(1)
    dispose()
  })

  it('repairs an incomplete tail before assigning the next sequence', async () => {
    const fixture = await createFixture()
    await fixture.log.append({ payload: {}, runId: 'run-1', type: 'run.started' })
    await appendFile(fixture.eventFile, '{"runId":"run-1"')

    await expect(fixture.log.read('run-1')).resolves.toHaveLength(1)
    await expect(fixture.log.append({ payload: {}, runId: 'run-1', type: 'audit.recorded' }))
      .resolves
      .toMatchObject({ sequence: 2 })
    await expect(fixture.log.read('run-1')).resolves.toHaveLength(2)
  })

  it('enters the fatal channel when the durable log is corrupted', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    await fixture.log.append({ payload: {}, runId: 'run-1', type: 'run.started' })
    await appendFile(fixture.eventFile, '{broken json}\n')

    const failure = await fixture.log.read('run-1').then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_LOG_CORRUPTED',
      commitState: 'not_applicable',
      runId: 'run-1',
    })
    expect(failures).toEqual([failure])
    await expect(fixture.log.append({ payload: {}, runId: 'run-1', type: 'audit.recorded' }))
      .rejects
      .toBe(failure)
  })

  it('enters the fatal channel when the durable event file cannot be read', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    await mkdir(fixture.eventFile, { recursive: true })

    const failure = await fixture.log.read('run-1').then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_STORAGE_FAILED',
      commitState: 'not_applicable',
      operation: 'read',
      runId: 'run-1',
      stage: 'read',
    })
    expect(failures).toEqual([failure])
    await expect(fixture.log.append({ payload: {}, runId: 'run-1', type: 'audit.recorded' }))
      .rejects
      .toBe(failure)
  })

  it('enters the fatal channel when the event directory cannot be created', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    await fixture.log.replay('run-1')
    const eventDirectory = dirname(fixture.eventFile)
    await mkdir(dirname(eventDirectory), { recursive: true })
    await writeFile(eventDirectory, 'not a directory', 'utf8')

    const failure = await fixture.log.append({
      payload: {},
      runId: 'run-1',
      type: 'audit.recorded',
    }).then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_STORAGE_FAILED',
      commitState: 'unknown',
      operation: 'append',
      runId: 'run-1',
      stage: 'mkdir',
    })
    expect(failures).toEqual([failure])
  })

  it('enters the fatal channel when the event file cannot be opened for append', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    await fixture.log.replay('run-1')
    await mkdir(fixture.eventFile, { recursive: true })

    const failure = await fixture.log.append({
      payload: {},
      runId: 'run-1',
      type: 'audit.recorded',
    }).then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_STORAGE_FAILED',
      commitState: 'unknown',
      operation: 'append',
      runId: 'run-1',
      stage: 'open',
    })
    expect(failures).toEqual([failure])
  })

  it('enters the fatal channel when persisted event files cannot be scanned', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    const eventDirectory = dirname(fixture.eventFile)
    await mkdir(dirname(eventDirectory), { recursive: true })
    await writeFile(eventDirectory, 'not a directory', 'utf8')

    const failure = await fixture.log.replayAll().then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_STORAGE_FAILED',
      commitState: 'not_applicable',
      operation: 'scan',
      runId: 'run-1',
      stage: 'readdir',
    })
    expect(failures).toEqual([failure])
    await expect(fixture.log.replayAll()).rejects.toBe(failure)
  })

  it('rejects empty and aggregate durable mutations after a fatal failure', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.eventFile, { recursive: true })
    const failure = await fixture.log.read('run-1').then(
      () => null,
      error => error,
    )

    await expect(fixture.log.appendBatch([])).rejects.toBe(failure)
    await expect(fixture.log.compactTerminalRuns()).rejects.toBe(failure)
  })

  it('keeps durable inspection and projection recovery available after a fatal failure', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.eventFile, { recursive: true })
    await expect(fixture.log.read('run-1')).rejects.toMatchObject({
      code: 'EVENT_STORAGE_FAILED',
    })
    await rm(fixture.eventFile, { force: true, recursive: true })

    await expect(fixture.log.read('run-1')).resolves.toEqual([])
    await expect(fixture.log.replay('run-1')).resolves.toBe(0)
    await expect(fixture.log.replayAll()).resolves.toBe(0)
  })

  it('atomically compacts transient terminal-run events in JSONL and SQLite', async () => {
    const fixture = await createFixture()
    await fixture.log.appendBatch([
      { payload: {}, runId: 'run-1', type: 'run.started' },
      {
        payload: { messageId: 'assistant-1' },
        runId: 'run-1',
        type: 'message.delta',
      },
      {
        payload: {
          content: { text: 'Final answer' },
          messageId: 'assistant-1',
          role: 'assistant',
          stopReason: 'completed',
        },
        runId: 'run-1',
        type: 'message.completed',
      },
      {
        payload: { toolCallId: 'tool-1' },
        runId: 'run-1',
        type: 'tool.updated',
      },
      {
        payload: { toolCallId: 'tool-1' },
        runId: 'run-1',
        type: 'tool.completed',
      },
      { payload: {}, runId: 'run-1', type: 'run.completed' },
    ])

    await expect(fixture.log.compactTerminalRun('run-1')).resolves.toBe(2)

    const expected = [
      { sequence: 1, type: 'run.started' },
      { sequence: 3, type: 'message.completed' },
      { sequence: 5, type: 'tool.completed' },
      { sequence: 6, type: 'run.completed' },
    ]
    expect(await fixture.log.read('run-1')).toMatchObject(expected)
    expect(await fixture.log.list('run-1')).toMatchObject(expected)
  })

  it('rebuilds product messages from durable events', async () => {
    const fixture = await createFixture()
    await fixture.log.append({
      payload: {
        content: { text: 'Durable answer' },
        messageId: 'assistant-1',
        role: 'assistant',
        stopReason: 'completed',
      },
      runId: 'run-1',
      type: 'message.completed',
    })
    fixture.database.exec(`
      DELETE FROM run_events WHERE run_id = 'run-1';
      DELETE FROM messages WHERE id = 'assistant-1';
    `)

    await expect(fixture.log.replay('run-1')).resolves.toBe(1)
    expect(fixture.database.prepare(`
      SELECT role, content_json FROM messages WHERE id = 'assistant-1'
    `).get()).toEqual({
      content_json: '{"text":"Durable answer"}',
      role: 'assistant',
    })
  })

  it('replays an answer referenced by a followup draft without losing the draft or its source', async () => {
    const fixture = await createFixture()
    await fixture.log.append({
      payload: { content: { text: 'Durable answer' }, messageId: 'assistant-1', role: 'assistant', stopReason: 'completed' },
      runId: 'run-1',
      type: 'message.completed',
    })
    const drafts = createComposerDraftRepository(fixture.database)
    const draft = drafts.open({
      draftId: 'followup-draft',
      initialContent: createBuddyUserContent('Preserved followup'),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      now: '2026-09-09T00:00:00.000Z',
      scope: { kind: 'message_followup', conversationId: 'conversation-1', branchId: 'branch-1', assistantMessageId: 'assistant-1' },
    })
    fixture.database.exec(`
      INSERT INTO attachments (id, message_id, stored_path, name, mime_type, size_bytes, created_at)
      VALUES ('attachment-1', 'assistant-1', '/isolated/answer.txt', 'answer.txt', 'text/plain', 1, '2026-09-09T00:00:00.000Z');
      UPDATE messages SET content_json = '{"text":"Damaged projection"}' WHERE id = 'assistant-1';
      INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      SELECT 'stale-answer', conversation_id, branch_id, run_id, role, content_json, created_at
      FROM messages WHERE id = 'assistant-1';
    `)
    const identity = fixture.database.prepare('SELECT rowid FROM messages WHERE id = ?').get('assistant-1')
    await expect(fixture.log.replay('run-1')).resolves.toBe(1)
    await expect(fixture.log.replay('run-1')).resolves.toBe(1)
    expect(drafts.findById(draft.draftId)).toEqual(draft)
    expect(fixture.database.prepare('SELECT rowid FROM messages WHERE id = ?').get('assistant-1')).toEqual(identity)
    expect(fixture.database.prepare('SELECT message_id FROM attachments WHERE id = ?').get('attachment-1'))
      .toEqual({ message_id: 'assistant-1' })
    expect(fixture.database.prepare('SELECT id FROM messages WHERE id = ?').get('stale-answer')).toBeUndefined()
    expect(fixture.database.prepare('SELECT content_json FROM messages WHERE id = ?').get('assistant-1'))
      .toEqual({ content_json: '{"text":"Durable answer"}' })
    expect(fixture.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(fixture.database.prepare('PRAGMA defer_foreign_keys').get()).toEqual({ defer_foreign_keys: 0 })
  })

  it.each(['duplicate', 'foreign-run'] as const)('rolls back a rebuild containing a %s message identity', async (conflict) => {
    const fixture = await createFixture()
    const event = await fixture.log.append({
      payload: { content: { text: 'Durable answer' }, messageId: 'assistant-1', role: 'assistant', stopReason: 'completed' },
      runId: 'run-1',
      type: 'message.completed',
    })
    fixture.database.exec(`
      INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      SELECT 'run-2', conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at FROM runs WHERE id = 'run-1';
      INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      SELECT 'assistant-2', conversation_id, branch_id, 'run-2', role, content_json, created_at FROM messages WHERE id = 'assistant-1';
      UPDATE messages SET content_json = '{"text":"Retained projection"}' WHERE id = 'assistant-1';
    `)
    const before = fixture.database.prepare('SELECT rowid, * FROM messages ORDER BY id').all()
    const projector = new RunEventProjector(fixture.database)
    expect(() => projector.rebuild('run-1', [event, {
      ...event,
      sequence: 2,
      payload: { ...event.payload as object, messageId: conflict === 'duplicate' ? 'assistant-1' : 'assistant-2' },
    }])).toThrow()
    expect(fixture.database.prepare('SELECT rowid, * FROM messages ORDER BY id').all()).toEqual(before)
    expect(await fixture.log.list('run-1')).toHaveLength(1)
  })

  it('enters the fatal channel when replay cannot rebuild the durable projection', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture({
      onFatalFailure: error => failures.push(error),
    })
    await fixture.log.append({
      payload: {
        content: { text: 'Durable answer' },
        messageId: 'assistant-1',
        role: 'assistant',
        stopReason: 'completed',
      },
      runId: 'run-1',
      type: 'message.completed',
    })
    fixture.database.exec(`
      CREATE TRIGGER reject_replayed_message
      BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'reject replay');
      END;
    `)

    const failure = await fixture.log.replay('run-1').then(
      () => null,
      error => error,
    )

    expect(failure).toMatchObject({
      code: 'EVENT_PROJECTION_FAILED',
      commitState: 'committed',
      firstSequence: 1,
      lastSequence: 1,
      runId: 'run-1',
    })
    expect(failures).toEqual([failure])
    await expect(fixture.log.append({
      payload: {},
      runId: 'run-1',
      type: 'audit.recorded',
    })).rejects.toBe(failure)
  })

  it('rejects mixed-run batches and new work after close', async () => {
    const fixture = await createFixture()
    await expect(fixture.log.appendBatch([
      { payload: {}, runId: 'run-1', type: 'audit.first' },
      { payload: {}, runId: 'run-2', type: 'audit.second' },
    ])).rejects.toThrow('must belong to one run')

    await fixture.log.close()
    await expect(fixture.log.append({ payload: {}, runId: 'run-1', type: 'audit.third' }))
      .rejects
      .toThrow('run event log is closed')
  })
})

async function createFixture(
  options: Pick<RunEventLogCallbacks, 'onFatalFailure'> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-events-'))
  directories.push(root)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  seedRun(database)
  const paths = new BuddyDataPaths(root)
  return {
    database,
    eventFile: paths.runEventFile('conversation-1', 'run-1'),
    log: createRunEventLog({
      conversationsDirectory: paths.conversationsDirectory,
      database,
      ...options,
    }),
  }
}

function seedRun(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at
    ) VALUES (
      'conversation-1', NULL, NULL, NULL,
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO conversation_branches (
      id, conversation_id, parent_branch_id, forked_from_message_id, created_at
    ) VALUES (
      'branch-1', 'conversation-1', NULL, NULL, '2026-08-14T00:00:00.000Z'
    );
    UPDATE conversations SET active_branch_id = 'branch-1' WHERE id = 'conversation-1';
    INSERT INTO messages (
      id, conversation_id, branch_id, run_id, role, content_json, created_at
    ) VALUES (
      'message-1', 'conversation-1', 'branch-1', NULL, 'user',
      '{"text":"hello"}', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO runs (
      id, conversation_id, branch_id, triggering_message_id, provider, model,
      purpose, status, pi_session_file, error_code, started_at, completed_at
    ) VALUES (
      'run-1', 'conversation-1', 'branch-1', 'message-1', 'anthropic',
      'claude-sonnet-4-5', 'chat', 'running', NULL, NULL,
      '2026-08-14T00:00:00.000Z', NULL
    );
  `)
}
