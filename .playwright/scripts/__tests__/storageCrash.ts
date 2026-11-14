import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { PreparedRunCommandService } from '../../../apps/buddy/service/src/chat/PreparedRunCommandService'
import { recoverSqliteRuns } from '../../../apps/buddy/service/src/runs/recoverSqliteRuns'
import { createAttachmentRepository } from '../../../apps/buddy/service/src/storage/attachmentRepository'
import { createComposerDraftRepository } from '../../../apps/buddy/service/src/storage/composerDraftRepository'
import { openBuddyMigrationCandidate } from '../../../apps/buddy/service/src/storage/database'
import { guardStorageDatabase } from '../../../apps/buddy/service/src/storage/StorageIsolation'
import { verifyCommandReceipt } from '../../../apps/buddy/service/src/storage/verifyCommandReceipt'
import { createBuddyUserContent } from '../../../apps/buddy/shared/conversation/buddyUserContent'

export const STORAGE_CRASH_POINTS = [
  'before-begin',
  'after-input',
  'after-draft',
  'after-receipt',
  'before-commit',
  'after-commit',
  'before-ack',
  'partial-ack',
  'after-ack',
] as const
type CrashPoint = typeof STORAGE_CRASH_POINTS[number]
const committedPoints = new Set<CrashPoint>(['after-commit', 'before-ack', 'partial-ack', 'after-ack'])
const transactionPoints = new Set<CrashPoint>(['after-input', 'after-draft', 'after-receipt', 'before-commit'])
const now = '2026-09-30T00:00:00.000Z'
const resource = 'Synthetic attachment retained across process interruption.\n'
const resourceHash = createHash('sha256').update(resource).digest('hex')

export interface StorageCrashFixture {
  directory: string
  dataGeneration: string
}

interface Checkpoint {
  point: CrashPoint
  inTransaction: boolean
}

function command(fixture: StorageCrashFixture) {
  return { dataGeneration: fixture.dataGeneration, actorId: 'desktop-local', commandId: 'command-1', fingerprintVersion: 1, fingerprint: 'fixture-intent-1' }
}

function input(fixture: StorageCrashFixture) {
  return {
    attachmentBindings: [{ id: 'file-1', sourceAttachmentId: 'file-1', sourceDraftId: 'draft-1', messageId: 'message-1', storedPath: join(fixture.directory, 'resource.txt'), createdAt: now }],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: now,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    draft: { draftId: 'draft-1', expectedRevision: 0 },
    model: 'fixture',
    provider: 'fixture',
    spaceId: null,
    runInput: { attachmentIds: ['file-1'], contextItems: [], prompt: 'Materialized fixture input', reasoning: null, serviceTier: null },
    runId: 'run-1',
    title: 'Fixture',
    userMessageContent: { text: 'Keep original input' },
    userMessageId: 'message-1',
  }
}

export function createStorageCrashFixture(directory: string): StorageCrashFixture {
  mkdirSync(directory)
  writeFileSync(join(directory, 'resource.txt'), resource)
  const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'candidate.sqlite3') })
  try {
    guardStorageDatabase(database)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    createComposerDraftRepository(database).open({
      draftId: 'draft-1',
      scope: { kind: 'global' },
      initialContent: createBuddyUserContent('Keep original input'),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: { modelId: 'fixture', providerId: 'fixture', reasoning: null, serviceTier: null },
      now,
    })
    const attachments = createAttachmentRepository(database)
    attachments.persistence?.adopt({ path: join(directory, 'resource.txt'), sizeBytes: resource.length, sha256: resourceHash })
    attachments.create({
      id: 'file-1',
      draftId: 'draft-1',
      messageId: null,
      conversationId: null,
      name: 'resource.txt',
      mimeType: 'text/plain',
      sizeBytes: resource.length,
      storedPath: join(directory, 'resource.txt'),
      createdAt: now,
    })
    const fixture = { directory, dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation) }
    writeFileSync(join(directory, 'fixture.json'), `${JSON.stringify(fixture)}\n`)
    return fixture
  }
  finally {
    database.close()
  }
}

export function acceptAtStorageCheckpoint(
  fixture: StorageCrashFixture,
  point: CrashPoint,
  checkpoint: (value: Checkpoint) => void,
  respond: (data: string) => void,
): void {
  const database = openBuddyMigrationCandidate({ databasePath: join(fixture.directory, 'candidate.sqlite3') })
  guardStorageDatabase(database)
  const owner = new PreparedRunCommandService({ database, sourceInstanceId: 'before-restart' })
  const exec = database.exec.bind(database)
  const stop = (candidate: CrashPoint) => {
    if (candidate === point)
      checkpoint({ point, inTransaction: database.isTransaction })
  }
  try {
    assert.equal(database.prepare('PRAGMA synchronous').get()!.synchronous, 2)
    assert.equal(database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal')
    database.function('fixture_checkpoint', (candidate) => {
      stop(candidate as CrashPoint)
      return null
    })
    database.exec(`
      CREATE TEMP TRIGGER fixture_input AFTER INSERT ON run_inputs
        BEGIN SELECT fixture_checkpoint('after-input'); END;
      CREATE TEMP TRIGGER fixture_draft AFTER UPDATE ON composer_drafts
        BEGIN SELECT fixture_checkpoint('after-draft'); END;
      CREATE TEMP TRIGGER fixture_receipt AFTER INSERT ON command_receipts
        BEGIN SELECT fixture_checkpoint('after-receipt'); END;
    `)
    database.exec = (sql) => {
      if (sql === 'COMMIT')
        stop('before-commit')
      exec(sql)
      if (sql === 'COMMIT')
        stop('after-commit')
    }
    stop('before-begin')
    const accepted = owner.start(command(fixture), input(fixture))
    stop('before-ack')
    const response = `${JSON.stringify({ commandId: 'command-1', receipt: accepted.receipt })}\n`
    if (point === 'partial-ack') {
      respond(response.slice(0, Math.floor(response.length / 2)))
      stop('partial-ack')
    }
    else {
      respond(response)
      stop('after-ack')
    }
    throw new Error(`Storage checkpoint was not interrupted: ${point}`)
  }
  finally {
    database.exec = exec
    owner.dispose()
    database.close()
  }
}

export async function verifyStorageCrash(fixture: StorageCrashFixture, point: CrashPoint, response: string) {
  const databasePath = join(fixture.directory, 'candidate.sqlite3')
  const committed = committedPoints.has(point)
  const originalReceipt = verifyCommandReceipt({ databasePath, identity: command(fixture) })
  assert.equal(originalReceipt !== null, committed)
  const reader = new DatabaseSync(databasePath, { readOnly: true })
  try {
    for (const table of ['conversations', 'conversation_branches', 'messages', 'runs', 'run_inputs', 'turn_requests', 'command_receipts', 'run_events'])
      assert.equal(reader.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, Number(committed), table)
    assert.equal(reader.prepare('SELECT revision FROM composer_drafts').get()!.revision, committed ? 1 : 0)
    assert.deepEqual({ ...reader.prepare('SELECT draft_id, message_id FROM attachments').get() }, committed
      ? { draft_id: null, message_id: 'message-1' }
      : { draft_id: 'draft-1', message_id: null })
    if (committed) {
      assert.deepEqual(JSON.parse(JSON.stringify(originalReceipt!.target)), { runId: 'run-1', conversationId: 'conversation-1', branchId: 'branch-1' })
      assert.equal(originalReceipt!.sourceInstanceId, 'before-restart')
      assert.equal(originalReceipt!.method, 'chat.startTurn')
      assert.deepEqual(JSON.parse(JSON.stringify(originalReceipt!.result)), { draftReceipt: { draftId: 'draft-1', sourceRevision: 0, committedRevision: 1 } })
      assert.deepEqual(JSON.parse(String(reader.prepare('SELECT content_json FROM messages').get()!.content_json)), { text: 'Keep original input' })
      assert.deepEqual({ ...reader.prepare('SELECT prompt, attachment_ids_json FROM run_inputs').get() }, { prompt: 'Materialized fixture input', attachment_ids_json: '["file-1"]' })
      assert.deepEqual({ ...reader.prepare('SELECT id, conversation_id, branch_id, status, next_event_sequence FROM runs').get() }, {
        id: 'run-1',
        conversation_id: 'conversation-1',
        branch_id: 'branch-1',
        status: 'queued',
        next_event_sequence: 2,
      })
    }
    assert.equal(reader.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    assert.deepEqual(reader.prepare('PRAGMA foreign_key_check').all(), [])
  }
  finally {
    reader.close()
  }
  if (point === 'after-ack') {
    assert.deepEqual(JSON.parse(response), JSON.parse(JSON.stringify({ commandId: 'command-1', receipt: originalReceipt })))
  }
  else if (point === 'partial-ack') {
    assert(response.length > 0 && !response.endsWith('\n'))
    assert.throws(() => JSON.parse(response))
  }
  else {
    assert.equal(response, '')
  }

  const database = openBuddyMigrationCandidate({ databasePath })
  guardStorageDatabase(database)
  const owner = new PreparedRunCommandService({ database, sourceInstanceId: 'after-restart' })
  try {
    const accepted = owner.start(command(fixture), input(fixture))
    assert.equal(accepted.created, !committed)
    if (committed)
      assert.deepEqual(accepted.receipt, originalReceipt)
    assert.deepEqual(owner.start(command(fixture), input(fixture)), { created: false, receipt: accepted.receipt })
    const conversationsDirectory = join(fixture.directory, 'conversations')
    assert.equal(await recoverSqliteRuns({ database, conversationsDirectory }), 1)
    assert.equal(await recoverSqliteRuns({ database, conversationsDirectory }), 0)
    assert.deepEqual(owner.find(command(fixture)), accepted.receipt)
    assert.equal(owner.start(command(fixture), input(fixture)).created, false)
    assert.equal(database.prepare('SELECT count(*) AS count FROM runs').get()!.count, 1)
    assert.deepEqual({ ...database.prepare('SELECT status, error_code FROM runs').get() }, { status: 'failed', error_code: 'RUNTIME_RESTARTED' })
    assert.equal(database.prepare('SELECT count(*) AS count FROM command_receipts').get()!.count, 1)
    assert.equal(database.prepare('SELECT revision FROM composer_drafts').get()!.revision, 1)
    assert.equal(createHash('sha256').update(readFileSync(join(fixture.directory, 'resource.txt'))).digest('hex'), resourceHash)
    return { point, committedBeforeRestart: committed, receipt: accepted.receipt, recoveredRuns: 1, finalRuns: 1, resourceHash }
  }
  finally {
    owner.dispose()
    database.close()
  }
}

export function runStorageCrashChild(directory: string, point: CrashPoint, nonce: string): void {
  assert(STORAGE_CRASH_POINTS.includes(point))
  const fixture = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8')) as StorageCrashFixture
  assert.equal(fixture.directory, directory)
  acceptAtStorageCheckpoint(fixture, point, (value) => {
    writeSync(3, `${JSON.stringify({ ...value, nonce })}\n`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)
    throw new Error('Storage crash parent did not terminate the paused child')
  }, data => writeSync(1, data))
}

interface ChildResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  error: { message: string, code?: string } | null
  checkpoint: Checkpoint | null
}

const children = new Set<ChildProcess>()

function runChild(args: string[], expected?: { point: CrashPoint, nonce: string }): Promise<ChildResult> {
  return new Promise((resolve) => {
    const result: ChildResult = { stdout: '', stderr: '', code: null, signal: null, error: null, checkpoint: null }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    children.add(child)
    const fail = (error: unknown) => {
      result.error ??= { message: String(error), ...((error as NodeJS.ErrnoException)?.code ? { code: (error as NodeJS.ErrnoException).code } : {}) }
      child.kill('SIGKILL')
    }
    const timeout = setTimeout(() => fail(new Error('Storage child timed out before verified exit')), 10000)
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      stream!.setEncoding('utf8')
      stream!.on('data', (chunk: string) => {
        if (result[name].length + chunk.length > 65536) {
          fail(new Error(`Storage child exceeded ${name} limit`))
          return
        }
        result[name] += chunk
      })
    }
    let control = ''
    const channel = child.stdio[3] as Readable
    channel.setEncoding('utf8')
    channel.on('data', (chunk: string) => {
      try {
        assert(expected, 'Unexpected storage child checkpoint')
        assert(control.length + chunk.length <= 4096, 'Storage child checkpoint exceeded limit')
        control += chunk
        if (!control.endsWith('\n'))
          return
        const message = JSON.parse(control) as Checkpoint & { nonce: string }
        assert.deepEqual(message, { ...expected, inTransaction: transactionPoints.has(expected.point) })
        assert.equal(result.checkpoint, null, 'Repeated storage child checkpoint')
        result.checkpoint = { point: message.point, inTransaction: message.inTransaction }
        assert(child.kill('SIGKILL'), 'Storage child could not be terminated')
      }
      catch (error) {
        fail(error)
      }
    })
    child.on('error', fail)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      children.delete(child)
      result.code = code
      result.signal = signal
      resolve(result)
    })
  })
}

export async function runStorageCrashes(root: string, bundle: string, bundleSha256: string): Promise<void> {
  const cases: Array<Awaited<ReturnType<typeof verifyStorageCrash>> & { child: ChildResult }> = []
  const report: {
    startedAt: string
    node: string
    platform: string
    arch: string
    bundleSha256: string
    status: 'running' | 'blocked' | 'failed' | 'passed'
    blockedReason?: string
    retainedFixture?: string
    preflight?: ChildResult
    cases: typeof cases
    error?: string
  } = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, bundleSha256, status: 'running', cases }
  const stopChildren = () => {
    for (const child of children)
      child.kill('SIGKILL')
  }
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    stopChildren()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const token = randomUUID()
    report.preflight = await runChild(['--input-type=module', '-e', 'process.stdout.write(process.argv[1])', token])
    assert(!interrupted, 'Storage process interruption acceptance was cancelled')
    if (report.preflight.error || report.preflight.code !== 0 || report.preflight.stdout !== token || process.platform === 'win32') {
      report.status = 'blocked'
      report.blockedReason = process.platform === 'win32'
        ? 'SIGKILL acceptance requires a POSIX host'
        : report.preflight.error
          ? `Child process error: ${report.preflight.error.message}`
          : report.preflight.code !== 0
            ? `Child process exited with code ${report.preflight.code}`
            : 'Child process exited without the required nonce response'
      process.exitCode = 1
      return
    }
    for (const point of STORAGE_CRASH_POINTS) {
      const directory = join(root, point)
      let verified = false
      report.retainedFixture = directory
      try {
        const fixture = createStorageCrashFixture(directory)
        const nonce = randomUUID()
        const child = await runChild([
          '--input-type=module',
          '-e',
          'const { runStorageCrashChild } = await import(process.argv[1]); runStorageCrashChild(process.argv[2], process.argv[3], process.argv[4]);',
          pathToFileURL(bundle).href,
          directory,
          point,
          nonce,
        ], { point, nonce })
        writeFileSync(join(root, `${point}.child.json`), `${JSON.stringify(child, null, 2)}\n`)
        assert(!interrupted, 'Storage process interruption acceptance was cancelled')
        assert.equal(child.error, null, JSON.stringify(child))
        assert.equal(child.signal, 'SIGKILL', JSON.stringify(child))
        assert.equal(child.checkpoint?.point, point, JSON.stringify(child))
        cases.push({ ...await verifyStorageCrash(fixture, point, child.stdout), child })
        assert(!interrupted, 'Storage process interruption acceptance was cancelled')
        verified = true
        process.stdout.write(`Storage process interruption verified: ${point}\n`)
      }
      finally {
        if (verified) {
          rmSync(directory, { recursive: true, force: true })
          delete report.retainedFixture
        }
      }
    }
    report.status = 'passed'
  }
  catch (error) {
    report.status = 'failed'
    report.error = String(error)
    throw error
  }
  finally {
    stopChildren()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`Storage process interruption status: ${report.status}; verified ${cases.length}/${STORAGE_CRASH_POINTS.length}\n`)
  }
}
