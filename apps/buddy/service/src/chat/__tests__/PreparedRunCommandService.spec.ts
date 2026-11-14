import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import type { AppendBuddyRunEventInput } from '../../events/BuddyRunEvent'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { RunEventQueries } from '../../events/RunEventQueries'
import { createAttachmentPersistenceRepository } from '../../storage/attachmentPersistenceRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate, openBuddySqliteDatabase } from '../../storage/database'
import { guardStorageDatabase } from '../../storage/StorageIsolation'
import { readTransactionFailure, withTransaction } from '../../storage/transaction'
import { verifyCommandReceipt } from '../../storage/verifyCommandReceipt'
import { PreparedRunCommandService } from '../PreparedRunCommandService'

const databases: SqliteDatabase[] = []
const services: PreparedRunCommandService[] = []
const directories: string[] = []
const now = '2026-09-29T00:00:00.000Z'

afterEach(() => {
  vi.restoreAllMocks()
  for (const service of services.splice(0))
    service.dispose()
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

function service(database: SqliteDatabase, sourceInstanceId = 'instance-1') {
  const instance = new PreparedRunCommandService({ database, sourceInstanceId })
  services.push(instance)
  return instance
}

function fixture(databasePath = ':memory:') {
  const database = open(databasePath)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const drafts = createComposerDraftRepository(database)
  drafts.open({
    draftId: 'draft-1',
    initialContent: createBuddyUserContent('Keep my input'),
    initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
    initialModelSelection: { modelId: 'fixture', providerId: 'fixture', reasoning: null, serviceTier: null },
    now,
    scope: { kind: 'global' },
  })
  const command = {
    dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation),
    actorId: 'desktop-local',
    commandId: 'command-1',
    fingerprintVersion: 1,
    fingerprint: 'prepared-intent-1',
  }
  return { database, drafts, command, owner: service(database), input: input() }
}

function input() {
  return {
    attachmentBindings: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: now,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    draft: { draftId: 'draft-1', expectedRevision: 0 },
    model: 'fixture',
    spaceId: null,
    provider: 'fixture',
    runInput: { attachmentIds: [], contextItems: [], prompt: 'Materialized input', reasoning: null, serviceTier: null },
    runId: 'run-1',
    title: 'Keep my input',
    userMessageContent: { text: 'Keep my input' },
    userMessageId: 'message-1',
  }
}

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-atomic-command-'))
  directories.push(directory)
  return join(directory, 'candidate.sqlite3')
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

function expectNoAcceptance(database: SqliteDatabase) {
  for (const table of ['conversations', 'conversation_branches', 'messages', 'runs', 'run_inputs', 'turn_requests', 'run_events', 'command_receipts'])
    expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
  expect(createComposerDraftRepository(database).findById('draft-1')).toMatchObject({ revision: 0, content: createBuddyUserContent('Keep my input') })
}

function terminalEvents(): AppendBuddyRunEventInput[] {
  return [
    { runId: 'run-1', type: 'run.started', payload: {}, createdAt: now },
    { runId: 'run-1', type: 'message.completed', payload: { messageId: 'answer-1', role: 'assistant', content: { text: 'Answer' }, stopReason: 'completed' }, createdAt: now },
    { runId: 'run-1', type: 'usage.recorded', payload: {
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
    }, createdAt: now },
    { runId: 'run-1', type: 'run.completed', payload: {}, createdAt: now },
  ]
}

describe('prepared run command atomic persistence', () => {
  it('refuses a pending migration instead of enabling normal admission', () => {
    const database = open()
    expect(() => service(database)).toThrow('authority is not ready')
    expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toEqual({ authority: 'legacy_jsonl', migration_state: 'pending' })
    expect(database.prepare('SELECT count(*) AS count FROM command_receipts').get()).toEqual({ count: 0 })
  })

  it('commits the input, draft, attachment binding, run fact and fixed receipt before publishing', () => {
    const f = fixture()
    const attachments = createAttachmentRepository(f.database)
    const files = createAttachmentPersistenceRepository(f.database)
    for (const path of ['/fixture/source.txt', '/fixture/message.txt'])
      files.adopt({ path, sizeBytes: 1, sha256: 'a'.repeat(64) })
    attachments.create({ id: 'file-1', conversationId: null, draftId: 'draft-1', messageId: null, name: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 1, storedPath: '/fixture/source.txt', createdAt: now })
    const delivered: string[] = []
    const observe = (kind: string) => {
      expect(f.database.isTransaction).toBe(false)
      expect(f.owner.find(f.command)?.target).toEqual({ runId: 'run-1', conversationId: 'conversation-1', branchId: 'branch-1' })
      expect(f.drafts.findById('draft-1')?.revision).toBe(1)
      delivered.push(kind)
    }
    f.owner.onDidCommit(() => observe('turn'))
    f.owner.events.onDidCommit((event) => {
      observe(event.type)
    })
    const accepted = f.owner.start(f.command, {
      ...f.input,
      runInput: { ...f.input.runInput, attachmentIds: ['file-1'] },
      attachmentBindings: [{ id: 'file-1', sourceAttachmentId: 'file-1', sourceDraftId: 'draft-1', messageId: 'message-1', storedPath: '/fixture/message.txt', createdAt: now }],
    })
    expect(accepted).toMatchObject({ created: true, receipt: {
      decision: 'accepted',
      method: 'chat.startTurn',
      sourceInstanceId: 'instance-1',
      target: { runId: 'run-1', conversationId: 'conversation-1', branchId: 'branch-1' },
      result: { draftReceipt: { draftId: 'draft-1', sourceRevision: 0, committedRevision: 1 } },
    } })
    expect(delivered).toEqual(['turn', 'run.queued'])
    expect(attachments.findById('file-1')).toMatchObject({ draftId: null, messageId: 'message-1' })
    expect(f.database.prepare('SELECT prompt, attachment_ids_json FROM run_inputs').get()).toEqual({ prompt: 'Materialized input', attachment_ids_json: '["file-1"]' })
    expect(f.database.prepare('SELECT status, next_event_sequence FROM runs').get()).toEqual({ status: 'queued', next_event_sequence: 2 })
    expect(new RunEventQueries(f.database).listForRuns(['run-1'])[0]).toMatchObject({ sequence: 1, type: 'run.queued' })
  })

  it.each([
    ['run input', 'BEFORE INSERT ON run_inputs'],
    ['command receipt', 'BEFORE INSERT ON command_receipts'],
  ])('rolls back every accepted fact when %s fails, then accepts the original ID', (_name, trigger) => {
    const f = fixture()
    const delivered: unknown[] = []
    f.owner.onDidCommit(event => delivered.push(event))
    f.owner.events.onDidCommit(event => delivered.push(event))
    f.database.exec(`CREATE TRIGGER reject_commit ${trigger} BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`)
    expect(() => f.owner.start(f.command, f.input)).toThrow('injected storage failure')
    expectNoAcceptance(f.database)
    expect(delivered).toEqual([])
    f.database.exec('DROP TRIGGER reject_commit')
    expect(f.owner.start(f.command, f.input).created).toBe(true)
    expect(delivered).toHaveLength(2)
  })

  it('participates in a larger owner transaction without publishing a receipt that is rolled back', () => {
    const f = fixture()
    const delivered: unknown[] = []
    f.owner.onDidCommit(event => delivered.push(event))
    f.owner.events.onDidCommit(event => delivered.push(event))
    expect(() => withTransaction(f.database, () => {
      f.owner.start(f.command, f.input)
      f.owner.events.appendBatch(terminalEvents())
      expect(delivered).toEqual([])
      expect(() => f.owner.find(f.command)).toThrow('active transaction')
      throw new Error('outer owner rejected')
    })).toThrow('outer owner rejected')
    expectNoAcceptance(f.database)
    expect(delivered).toEqual([])
  })

  it.each(['edit', 'regenerate', 'compact'] as const)('commits %s through the same receipt boundary without damaging the source run', (method) => {
    const f = fixture()
    const first = f.owner.start(f.command, f.input)
    f.owner.events.appendBatch(terminalEvents())
    f.database.exec('UPDATE runs SET pi_session_file = \'/fixture/session.jsonl\' WHERE id = \'run-1\'')
    const command = { ...f.command, commandId: 'command-2', fingerprint: method }
    const base = { ...f.input, branchId: 'branch-2', runId: 'run-2', parentBranchId: 'branch-1' }
    let accept: () => ReturnType<PreparedRunCommandService['start']>
    if (method === 'regenerate') {
      accept = () => f.owner.regenerate(command, { ...base, reasoning: null, serviceTier: null, expectedModelSelection: createConversationRepository(f.database).findById('conversation-1')!.modelSelection, sourceRunId: 'run-1', forkedFromMessageId: 'message-1' })
    }
    else {
      const opened = f.drafts.open({
        draftId: 'draft-2',
        initialContent: createBuddyUserContent(method === 'edit' ? 'Edited input' : '/compact'),
        initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
        initialModelSelection: { modelId: 'fixture', providerId: 'fixture', reasoning: null, serviceTier: null },
        now,
        scope: method === 'edit'
          ? { kind: 'message_edit', conversationId: 'conversation-1', branchId: 'branch-1', userMessageId: 'message-1' }
          : { kind: 'conversation_branch', conversationId: 'conversation-1', branchId: 'branch-1' },
      })
      const saved = f.drafts.save({
        draftId: opened.draftId,
        expectedRevision: opened.revision,
        content: createBuddyUserContent(method === 'edit' ? 'Edited input' : '/compact'),
        executionConfig: opened.executionConfig,
        modelSelection: opened.modelSelection,
        now,
      })
      const draft = { draftId: saved.draftId, expectedRevision: saved.revision }
      accept = method === 'edit'
        ? () => f.owner.edit(command, { ...base, draft, sourceUserMessageId: 'message-1', forkedFromMessageId: null, userMessageId: 'message-2' })
        : () => f.owner.compact(command, { ...base, branchId: 'branch-1', draft, command: 'compact', arguments: 'Preserve decisions' })
    }
    const draftsBefore = f.database.prepare('SELECT * FROM composer_drafts ORDER BY id').all()
    f.database.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    expect(accept).toThrow('receipt unavailable')
    expect(f.database.prepare('SELECT id, status FROM runs').all()).toEqual([{ id: 'run-1', status: 'completed' }])
    expect(f.database.prepare('SELECT active_branch_id FROM conversations').get()).toEqual({ active_branch_id: 'branch-1' })
    expect(f.database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(f.database.prepare('SELECT * FROM composer_drafts ORDER BY id').all()).toEqual(draftsBefore)
    f.database.exec('DROP TRIGGER reject_receipt')
    const accepted = accept()
    expect(accepted).toMatchObject({ created: true, receipt: { target: { runId: 'run-2' } } })
    expect(accept()).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.owner.find(f.command)).toEqual(first.receipt)
    expect(new RunEventQueries(f.database).listForRuns(['run-2'])).toMatchObject([{ sequence: 1, type: 'run.queued' }])
    expect(f.database.prepare('SELECT purpose, next_event_sequence FROM runs WHERE id = \'run-2\'').get()).toEqual({ purpose: method === 'compact' ? 'conversation.compaction' : 'chat', next_event_sequence: 2 })
  })

  it('rolls back attachment ownership along with a failed command receipt', () => {
    const f = fixture()
    const attachments = createAttachmentRepository(f.database)
    const files = createAttachmentPersistenceRepository(f.database)
    for (const path of ['/fixture/source.txt', '/fixture/message.txt'])
      files.adopt({ path, sizeBytes: 1, sha256: 'a'.repeat(64) })
    attachments.create({ id: 'file-1', conversationId: null, draftId: 'draft-1', messageId: null, name: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 1, storedPath: '/fixture/source.txt', createdAt: now })
    const original = attachments.findById('file-1')
    f.database.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    expect(() => f.owner.start(f.command, {
      ...f.input,
      runInput: { ...f.input.runInput, attachmentIds: ['file-1'] },
      attachmentBindings: [{ id: 'file-1', sourceAttachmentId: 'file-1', sourceDraftId: 'draft-1', messageId: 'message-1', storedPath: '/fixture/message.txt', createdAt: now }],
    })).toThrow('receipt unavailable')
    expect(attachments.findById('file-1')).toEqual(original)
    expectNoAcceptance(f.database)
  })

  it('keeps the original receipt after restart and terminal state instead of consuming the draft again', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const accepted = f.owner.start(f.command, f.input)
    f.owner.events.appendBatch(terminalEvents())
    f.owner.dispose()
    f.database.close()
    const database = open(databasePath)
    const restarted = service(database, 'instance-2')
    const replay = restarted.start(f.command, { ...f.input, runId: 'must-not-exist', draft: { draftId: 'deleted-draft', expectedRevision: 99 } })
    expect(replay).toEqual({ created: false, receipt: accepted.receipt })
    expect(database.prepare('SELECT id, status FROM runs').all()).toEqual([{ id: 'run-1', status: 'completed' }])
    expect(createComposerDraftRepository(database).findById('draft-1')?.revision).toBe(1)
    expect(() => restarted.start({ ...f.command, fingerprint: 'different' }, f.input)).toThrow('recorded intent')
    expect(() => restarted.start({ ...f.command, dataGeneration: 'old-generation' }, f.input)).toThrow('generation is not current')
    database.exec('UPDATE storage_actors SET state = \'revoked\'')
    expect(() => restarted.start(f.command, f.input)).toThrow('actor is not active')
  })

  it('retains SQLITE_FULL and restores the draft without leaving accepted rows', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const revisions = f.database.prepare('SELECT * FROM product_query_revisions ORDER BY table_name').all()
    const pageCount = Number(f.database.prepare('PRAGMA page_count').get()!.page_count)
    f.database.exec(`PRAGMA max_page_count = ${pageCount + 2}`)
    const failure = capture(() => f.owner.start(f.command, { ...f.input, runInput: { ...f.input.runInput, prompt: 'x'.repeat(2_000_000) } }))
    expect(failure).toMatchObject({ errcode: 13 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'operation', outcome: 'rolled_back' })
    const reopened = open(databasePath)
    expectNoAcceptance(reopened)
    expect(reopened.prepare('SELECT * FROM product_query_revisions ORDER BY table_name').all()).toEqual(revisions)
  })

  it('rolls back a real COMMIT BUSY without publishing accepted facts', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const isolation = guardStorageDatabase(f.database)
    f.database.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0')
    const reader = new DatabaseSync(databasePath)
    databases.push(reader)
    reader.exec('BEGIN; SELECT * FROM composer_drafts')
    const delivered: unknown[] = []
    f.owner.events.onDidCommit(event => delivered.push(event))
    const failure = capture(() => f.owner.start(f.command, f.input))
    expect(failure).toMatchObject({ errcode: 5 })
    expect(readTransactionFailure(failure)).toEqual({ phase: 'commit', outcome: 'rolled_back' })
    expectNoAcceptance(f.database)
    expect(delivered).toEqual([])
    expect(isolation.failure).toBeNull()
    reader.exec('ROLLBACK')
    expect(f.owner.start(f.command, f.input).created).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(['sqlite', 'incompatible'] as const)('isolates a real COMMIT journal deletion failure and validates %s recovery before writing', (mode) => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const isolation = guardStorageDatabase(f.database)
    f.database.exec('PRAGMA journal_mode = DELETE')
    if (mode === 'incompatible')
      f.database.exec('PRAGMA user_version = 999')
    expect(f.database.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    const exec = f.database.exec.bind(f.database)
    let physicalError: unknown
    const injected = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT')
        chmodSync(dirname(databasePath), 0o500)
      try {
        exec(sql)
      }
      catch (error) {
        if (sql === 'COMMIT')
          physicalError = error
        throw error
      }
    })
    const delivered: unknown[] = []
    f.owner.onDidCommit(event => delivered.push(event))
    f.owner.events.onDidCommit(event => delivered.push(event))
    try {
      const failure = capture(() => f.owner.start(f.command, f.input))
      expect(physicalError).toMatchObject({ errcode: 2570 })
      expect(failure).toMatchObject({ code: 'STORAGE_TRANSACTION_UNCERTAIN', cause: physicalError })
      expect(readTransactionFailure(failure)).toMatchObject({ phase: 'commit', outcome: 'unknown' })
      expect(isolation.failure?.cause).toBe(physicalError)
      expect(delivered).toEqual([])
      expect(() => f.owner.start(f.command, f.input)).toThrow('requires verification')
      expect(() => f.owner.find(f.command)).toThrow('requires verification')
      expect(() => f.database.prepare('SELECT * FROM command_receipts')).toThrow('Storage is isolated')
      injected.mockRestore()
      f.database.close()
      const journal = `${databasePath}-journal`
      const databaseBytes = readFileSync(databasePath)
      const journalBytes = readFileSync(journal)
      expect(capture(() => verifyCommandReceipt({ databasePath, identity: f.command }))).toMatchObject({ errcode: 776 })
      expect(readFileSync(databasePath)).toEqual(databaseBytes)
      expect(readFileSync(journal)).toEqual(journalBytes)
    }
    finally {
      injected.mockRestore()
      chmodSync(dirname(databasePath), 0o700)
    }
    if (mode === 'incompatible') {
      const bytes = readFileSync(databasePath)
      const journal = readFileSync(`${databasePath}-journal`)
      for (const opener of [openBuddyMigrationCandidate, openBuddySqliteDatabase])
        expect(() => opener({ databasePath })).toThrow('newer schema version')
      expect(readFileSync(databasePath)).toEqual(bytes)
      expect(readFileSync(`${databasePath}-journal`)).toEqual(journal)
      return
    }
    const database = openBuddySqliteDatabase({ databasePath })
    databases.push(database)
    guardStorageDatabase(database)
    expectNoAcceptance(database)
    expect(existsSync(`${databasePath}-journal`)).toBe(false)
    expect(verifyCommandReceipt({ databasePath, identity: f.command })).toBeNull()
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const restarted = service(database, 'instance-2')
    const accepted = restarted.start(f.command, f.input)
    expect(accepted).toMatchObject({ created: true, receipt: { target: { runId: 'run-1' } } })
    expect(restarted.start(f.command, f.input)).toEqual({ created: false, receipt: accepted.receipt })
    expect(verifyCommandReceipt({ databasePath, identity: f.command })).toEqual(accepted.receipt)
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 })
    expect(createComposerDraftRepository(database).findById('draft-1')?.revision).toBe(1)
  })

  it('returns no early success after an uncertain COMMIT and recovers the fixed receipt on reopen', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    const isolation = guardStorageDatabase(f.database)
    const exec = f.database.exec.bind(f.database)
    const failure = new Error('COMMIT response lost')
    const injected = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw failure
    })
    const delivered: unknown[] = []
    f.owner.events.onDidCommit(event => delivered.push(event))
    expect(capture(() => f.owner.start(f.command, f.input))).toMatchObject({ code: 'STORAGE_TRANSACTION_UNCERTAIN', cause: failure })
    expect(delivered).toEqual([])
    expect(() => f.owner.start(f.command, f.input)).toThrow('requires verification')
    expect(() => f.owner.find(f.command)).toThrow('requires verification')
    const receipt = verifyCommandReceipt({ databasePath, identity: f.command })
    expect(receipt).toMatchObject({ target: { runId: 'run-1' }, sourceInstanceId: 'instance-1' })
    expect(() => isolation.assertAvailable()).toThrow('Storage is isolated')
    expect(() => f.database.prepare('DELETE FROM runs')).toThrow('Storage is isolated')
    injected.mockRestore()
    f.database.close()
    const database = open(databasePath)
    const restored = service(database, 'instance-2').start(f.command, f.input)
    expect(restored).toMatchObject({ created: false, receipt: { target: { runId: 'run-1' }, sourceInstanceId: 'instance-1' } })
    expect(restored.receipt).toEqual(receipt)
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 })
  })

  it('does not expose uncommitted receipts when COMMIT and cleanup both fail', () => {
    const databasePath = temporaryPath()
    const f = fixture(databasePath)
    guardStorageDatabase(f.database)
    const exec = f.database.exec.bind(f.database)
    const injected = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' || sql === 'ROLLBACK')
        throw new Error(`Unavailable ${sql}`)
      exec(sql)
    })
    const failure = capture(() => f.owner.start(f.command, f.input))
    expect(readTransactionFailure(failure)).toMatchObject({ phase: 'commit', outcome: 'unknown' })
    expect(f.database.isTransaction).toBe(true)
    expect(() => f.database.prepare('SELECT count(*) AS count FROM command_receipts')).toThrow('Storage is isolated')
    expect(() => f.owner.find(f.command)).toThrow('requires verification')
    expect(verifyCommandReceipt({ databasePath, identity: f.command })).toBeNull()
    const reader = new DatabaseSync(databasePath, { readOnly: true })
    databases.push(reader)
    expectNoAcceptance(reader)
    injected.mockRestore()
    exec('ROLLBACK')
    f.database.close()
    const reopened = open(databasePath)
    expectNoAcceptance(reopened)
    expect(verifyCommandReceipt({ databasePath, identity: f.command })).toBeNull()
    expect(service(reopened, 'instance-2').start(f.command, f.input).created).toBe(true)
  })
})
