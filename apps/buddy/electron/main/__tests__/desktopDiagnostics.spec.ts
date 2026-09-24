import type { DesktopDiagnosticLoggerOptions, DesktopDiagnosticRecord } from '../desktopDiagnostics'
import { Buffer } from 'node:buffer'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { PrivateDirectoryError } from '../../../platform/windows/privateDirectories'
import { ServiceHost } from '../../../shared/lifecycle/ServiceHost'
import { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { DiagnosticFile } from '../diagnostics/diagnosticFile'
import { MAX_DIAGNOSTIC_RECORD_BYTES, redactDiagnosticText } from '../diagnostics/diagnosticRecord'

const event = { scope: 'desktop', level: 'info', event: 'app.test' } as const

async function createLogger(options: Partial<DesktopDiagnosticLoggerOptions> = {}) {
  const directory = options.directory ?? await createTemporaryDirectory('lexora-recorder-')
  const logger = new DesktopDiagnosticLogger({ directory, appVersion: '0.3.0', userHome: '/home/alice', ...options })
  onTestFinished(async () => {
    await logger.close()
  })
  return { directory, logger }
}

async function readRecords(directory: string, file = 'application.jsonl'): Promise<DesktopDiagnosticRecord[]> {
  const text = await readFile(join(directory, file), 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  return text.trimEnd().split('\n').map(line => JSON.parse(line) as DesktopDiagnosticRecord)
}

afterEach(() => vi.restoreAllMocks())

describe('desktop diagnostics', () => {
  it('bounds recovery flush without closing the logger or losing later recovery actions', async () => {
    const { logger } = await createLogger()
    const blocked = deferred<void>()
    vi.spyOn(DiagnosticFile.prototype, 'append').mockImplementation(async () => blocked.promise)
    logger.record(event)
    const status = await logger.flushWithin(10)
    expect(status).toMatchObject({ state: 'open', accepted: 1, written: 0 })
    expect(status.pendingBytes).toBeGreaterThan(0)
    expect(logger.record({ ...event, event: 'startup.recovery.action_requested', recoveryAction: 'quit' })).toBe(true)
    blocked.resolve()
    expect(await logger.flush()).toMatchObject({ state: 'open', written: 2, pendingBytes: 0 })
  })

  it('carries safe native failure details through lifecycle recording and log queries', async () => {
    const { directory, logger } = await createLogger()
    const events = new ApplicationEvents()
    events.subscribe(event => logger.record({ ...event, scope: 'desktop' }))
    const host = new ServiceHost(events)
    const failure = { kind: 'private_directories', operation: 'open_directory', directoryRole: 'session_data', systemError: { domain: 'ntstatus', code: 0xC0000022 }, exitCode: 1 } as const
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_FAILED', failure, { cause: new Error('token=fixture-secret') })
    await expect(host.step('desktop.environment', () => {
      throw error
    })).rejects.toBe(error)
    await logger.close()
    const records = await readRecords(directory)
    expect(records.at(-1)).toMatchObject({ errorCode: error.code, errorType: 'PrivateDirectoryError', failure })
    expect(JSON.stringify(records)).not.toContain('fixture-secret')
    const reader = new ApplicationLogReader(directory, logger.launchId, '/home/alice')
    const page = await reader.query({ level: 'error' })
    expect(page.records[0]).toMatchObject({ failure })
  })

  it('retains run and turn identities while excluding arbitrary operation details', async () => {
    const { directory, logger } = await createLogger()
    const input = {
      scope: 'local-service' as const,
      level: 'info' as const,
      event: 'turn.completed',
      component: 'agent',
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      runId: 'run-1',
      turnId: 'run-1:2',
      requestId: 'request-1',
      sourceId: 'runtime-1',
      sourcePid: 42,
      durationMs: 123,
      payload: { prompt: 'fixture-private-prompt' },
      response: 'fixture-private-response',
    }
    expect(logger.record(input)).toBe(true)
    await logger.close()
    const records = await readRecords(directory)
    expect(records[0]).toMatchObject({ conversationId: 'conversation-1', branchId: 'branch-1', runId: 'run-1', turnId: 'run-1:2', requestId: 'request-1', sourcePid: 42, durationMs: 123 })
    expect(JSON.stringify(records)).not.toContain('fixture-private')
    expect(records[0]).not.toHaveProperty('payload')
    expect(records[0]).not.toHaveProperty('response')
  })
  it('redacts credentials and home paths, including Windows variants', () => {
    const text = redactDiagnosticText([
      'failed /home/alice/workspace Authorization: Bearer fixture-bearer',
      'api_key="fixture key" password=fixture-password access_token=fixture-token',
      'Cookie: session=fixture-cookie; other=fixture-value',
      'https://fixture-user:fixture-pass@example.test/?token=fixture-query',
      'sk-fixture-secret',
    ].join('\n'), '/home/alice')
    expect(text).toContain('<home>/workspace')
    expect(text).not.toContain('fixture-')
    expect(text).not.toContain('fixture key')
    expect(redactDiagnosticText('c:\\users\\Alice\\log C:/Users/ALICE/log', 'C:\\Users\\Alice'))
      .toBe('<home>\\log <home>/log')
    expect(redactDiagnosticText('plain text', '')).toBe('plain text')
  })

  it('writes ordered, private JSONL with launch context and safe error fields', async () => {
    const { directory, logger } = await createLogger()
    const error = Object.assign(new Error('failed /home/alice/workspace token=fixture-secret'), {
      code: 'EACCES',
      request: { apiKey: 'fixture-payload' },
    })
    logger.record({ ...event, message: 'first\nsecond', operationId: 'startup-1', durationMs: 12 })
    logger.record({ ...event, level: 'error', error })
    expect(logger.status.written).toBe(0)
    expect(await logger.close()).toMatchObject({ accepted: 2, written: 2, failed: 0, state: 'closed', closeTimedOut: false })
    const records = await readRecords(directory)
    expect(records.map(record => record.sequence)).toEqual([1, 2])
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      appVersion: '0.3.0',
      platform: process.platform,
      collectorPid: process.pid,
      message: 'first\nsecond',
      operationId: 'startup-1',
      durationMs: 12,
    })
    expect(records[0]!.launchId).toBe(records[1]!.launchId)
    expect(records[1]!.error).toMatchObject({ name: 'Error', code: 'EACCES', message: 'failed <home>/workspace token=<redacted>' })
    expect(JSON.stringify(records)).not.toContain('fixture-')
    expect(records[1]!.error).not.toHaveProperty('request')
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'application.jsonl'))).mode & 0o777).toBe(0o600)
    }
  })

  it('reassembles UTF-8 and secrets across chunks before redaction', async () => {
    const { directory, logger } = await createLogger()
    const output = logger.createWritable('local-service')
    const bytes = Buffer.from('中文 Authorization: Bearer fixture-secret\r\n  next line\nlast line')
    for (const byte of bytes)
      output.write(Buffer.from([byte]))
    await logger.close()
    const records = await readRecords(directory)
    expect(records.map(record => record.message)).toEqual([
      '中文 Authorization: <redacted>',
      '  next line',
      'last line',
    ])
    expect(new Set(records.map(record => record.sourceId)).size).toBe(1)
    expect(records.every(record => record.scope === 'local-service')).toBe(true)
  })

  it('does not emit partial lines during flush and continues writing after flush', async () => {
    const { directory, logger } = await createLogger()
    const output = logger.createWritable('local-service')
    output.write('Authorization: Bea')
    await logger.flush()
    expect(logger.status.accepted).toBe(0)
    output.write('rer fixture-secret\n')
    await logger.flush()
    for (let index = 0; index < 4; index++) {
      logger.record({ ...event, message: `next-${index}` })
      await logger.flush()
    }
    await logger.close()
    expect((await readRecords(directory)).map(record => record.message))
      .toEqual(['Authorization: <redacted>', 'next-0', 'next-1', 'next-2', 'next-3'])
  })

  it('discards an oversized line in full and resumes at the next newline', async () => {
    const { directory, logger } = await createLogger()
    const output = logger.createWritable('native-pet')
    output.write('x'.repeat(MAX_DIAGNOSTIC_RECORD_BYTES))
    output.write('Authorization: Bea')
    output.write('rer fixture-secret\nrecovered\n')
    expect(logger.record({ ...event, message: 'x'.repeat(MAX_DIAGNOSTIC_RECORD_BYTES) })).toBe(false)
    await logger.close()
    const records = await readRecords(directory)
    expect(records.filter(record => record.scope === 'native-pet').map(record => record.message)).toEqual(['recovered'])
    expect(logger.status.dropped).toBe(2)
    expect(records.find(record => record.event === 'recorder.loss')?.recorderLoss).toEqual({ dropped: 2, failed: 0 })
    expect(JSON.stringify(records)).not.toContain('fixture-secret')
  })

  it('bounds the pending queue without accumulating a Writable backlog', async () => {
    const { directory, logger } = await createLogger({ maxQueueBytes: MAX_DIAGNOSTIC_RECORD_BYTES })
    const output = logger.createWritable('local-service')
    for (let index = 0; index < 100; index++)
      output.write(`${index} ${'x'.repeat(2000)}\n`)
    expect(logger.status.pendingBytes).toBeLessThanOrEqual(MAX_DIAGNOSTIC_RECORD_BYTES)
    expect(output.writableLength).toBe(0)
    expect(logger.status.dropped).toBeGreaterThan(0)
    await logger.close()
    const records = await readRecords(directory)
    expect(records.filter(record => record.scope === 'local-service').length + logger.status.dropped).toBe(100)
    expect(logger.status.pendingBytes).toBe(0)
  })

  it('persists a loss summary even when every input was rejected', async () => {
    const { directory, logger } = await createLogger()
    logger.record({ ...event, message: 'x'.repeat(MAX_DIAGNOSTIC_RECORD_BYTES) })
    expect(await logger.close()).toMatchObject({ dropped: 1, written: 1 })
    expect((await readRecords(directory))[0]).toMatchObject({
      event: 'recorder.loss',
      recorderLoss: { dropped: 1, failed: 0 },
    })
  })

  it('bounds file size and count while retaining the latest complete records', async () => {
    const { directory, logger } = await createLogger({ maxFileBytes: MAX_DIAGNOSTIC_RECORD_BYTES, maxFiles: 3 })
    for (let index = 0; index < 8; index++) {
      logger.record({ ...event, operationId: String(index), message: 'x'.repeat(10000) })
      await logger.flush()
    }
    await logger.close()
    const files = await readdir(directory)
    expect(files.sort()).toEqual(['application.1.jsonl', 'application.2.jsonl', 'application.jsonl'])
    for (const file of files)
      expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(MAX_DIAGNOSTIC_RECORD_BYTES)
    expect((await readRecords(directory))[0]!.operationId).toBe('7')
    expect((await readRecords(directory, 'application.2.jsonl'))[0]!.operationId).toBe('5')
  })

  it('starts a clean file after a previous launch ended with an incomplete line', async () => {
    const directory = await createTemporaryDirectory('lexora-recorder-restart-')
    await writeFile(join(directory, 'application.jsonl'), '{"interrupted":')
    const first = await createLogger({ directory })
    first.logger.record(event)
    await first.logger.close()
    const previous = (await readRecords(directory))[0]!
    const second = await createLogger({ directory })
    second.logger.record(event)
    await second.logger.close()
    expect((await readRecords(directory))[0]!.launchId).not.toBe(previous.launchId)
    expect(await readFile(join(directory, 'application.2.jsonl'), 'utf8')).toBe('{"interrupted":')
  })

  it('isolates filesystem failure from callers and streams, then recovers on later input', async () => {
    const root = await createTemporaryDirectory('lexora-recorder-failure-')
    const directory = join(root, 'blocked')
    await writeFile(directory, 'not a directory')
    const { logger } = await createLogger({ directory })
    const output = logger.createWritable('local-service')
    const errors: Error[] = []
    output.on('error', error => errors.push(error))
    output.write('first\n')
    expect(await logger.flush()).toMatchObject({ failed: 1, written: 0, pendingBytes: 0 })
    expect(logger.status.lastError).toBeTruthy()
    expect(errors).toEqual([])
    expect(logger.record(event)).toBe(false)
    await rm(directory)
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2000)
    expect(logger.record({ ...event, message: 'recovered' })).toBe(true)
    await logger.close()
    expect((await readRecords(directory)).map(record => record.event)).toEqual(['app.test', 'recorder.loss'])
    expect((await readRecords(directory)).at(-1)?.recorderLoss).toEqual({ dropped: 1, failed: 1 })
    expect(logger.status.failed).toBe(1)
  })

  it('isolates rotation failure and reports it without overwriting existing records', async () => {
    const { directory, logger } = await createLogger({ maxFileBytes: MAX_DIAGNOSTIC_RECORD_BYTES, maxFiles: 2 })
    logger.record({ ...event, message: 'x'.repeat(10000) })
    await logger.flush()
    await mkdir(join(directory, 'application.1.jsonl'))
    logger.record({ ...event, message: 'y'.repeat(10000) })
    await logger.close()
    expect(logger.status.failed).toBe(1)
    expect((await readRecords(directory))[0]!.message).toBe('x'.repeat(10000))
  })

  it('waits for captured stream EOF and keeps process generations separate', async () => {
    const { directory, logger } = await createLogger()
    const first = new PassThrough()
    const second = new PassThrough()
    logger.captureOutput('local-service', first)
    logger.captureOutput('local-service', second)
    first.write('first tail')
    second.write('Authorization: Bea')
    const closing = logger.close()
    expect(logger.record(event)).toBe(false)
    first.end()
    second.end('rer fixture-secret')
    expect(await closing).toMatchObject({ written: 2, closeTimedOut: false })
    const records = await readRecords(directory)
    expect(records.map(record => record.message)).toEqual(['first tail', 'Authorization: <redacted>'])
    expect(records[0]!.sourceId).not.toBe(records[1]!.sourceId)
  })

  it('bounds shutdown when a captured source never finishes', async () => {
    const { logger } = await createLogger({ closeTimeoutMs: 20 })
    const source = new PassThrough()
    logger.captureOutput('local-service', source)
    source.write('unfinished')
    const closing = logger.close()
    expect(logger.close()).toBe(closing)
    expect(await closing).toMatchObject({ state: 'closed', closeTimedOut: true, unconfirmed: 1 })
    source.end()
    expect(logger.record(event)).toBe(false)
  })

  it('records source read errors and still closes without waiting for EOF', async () => {
    const { directory, logger } = await createLogger()
    const source = new PassThrough()
    logger.captureOutput('local-service', source)
    source.destroy(new Error('stderr read failed'))
    expect(await logger.close()).toMatchObject({ written: 1, closeTimedOut: false })
    expect((await readRecords(directory))[0]).toMatchObject({
      event: 'process.stderr_failed',
      error: { message: 'stderr read failed' },
    })
  })

  it('bounds shutdown during a stalled write without reporting it as written', async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    vi.spyOn(DiagnosticFile.prototype, 'append').mockImplementation(async () => {
      entered.resolve()
      await gate.promise
    })
    const { logger } = await createLogger({ closeTimeoutMs: 20 })
    logger.record(event)
    await entered.promise
    expect(await logger.close()).toMatchObject({ written: 0, unconfirmed: 1, closeTimedOut: true, pendingBytes: 0 })
    gate.resolve()
    await logger.flush()
    expect(logger.status.written).toBe(0)
  })

  it('rejects late writes safely and closes idempotently', async () => {
    const { directory, logger } = await createLogger()
    const output = logger.createWritable('local-service')
    output.write('tail')
    const closing = logger.close()
    expect(logger.close()).toBe(closing)
    await closing
    const error = await new Promise<Error | null | undefined>(resolve => output.write('late\n', resolve))
    expect(error).toBeInstanceOf(Error)
    expect(logger.record(event)).toBe(false)
    expect((await readRecords(directory)).map(record => record.message)).toEqual(['tail'])
  })
})
