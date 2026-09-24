import type { Writable } from 'node:stream'
import type { CapturedDiagnosticOutput } from './diagnostics/diagnosticOutput'
import type { DesktopDiagnosticEvent, DesktopDiagnosticScope, DiagnosticContext } from './diagnostics/diagnosticRecord'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { APPLICATION_LOG_MAX_FILE_BYTES, APPLICATION_LOG_MAX_FILES } from '../../shared/diagnostics/applicationLog'
import { DiagnosticFile } from './diagnostics/diagnosticFile'
import { captureDiagnosticOutput, createDiagnosticOutput } from './diagnostics/diagnosticOutput'
import { encodeDiagnosticRecord, MAX_DIAGNOSTIC_RECORD_BYTES, redactDiagnosticText } from './diagnostics/diagnosticRecord'

export type { DesktopDiagnosticEvent, DesktopDiagnosticRecord, DesktopDiagnosticScope } from './diagnostics/diagnosticRecord'

export interface DesktopDiagnosticLoggerOptions {
  directory: string
  appVersion: string
  userHome: string
  maxFileBytes?: number
  maxFiles?: number
  maxQueueBytes?: number
  closeTimeoutMs?: number
}

export interface DesktopDiagnosticStatus {
  accepted: number
  written: number
  dropped: number
  failed: number
  unconfirmed: number
  pendingBytes: number
  lastError: string | null
  state: 'open' | 'closing' | 'closed'
  closeTimedOut: boolean
}

export class DesktopDiagnosticLogger {
  readonly #context: DiagnosticContext
  readonly #userHome: string
  readonly #startedAt = performance.now()
  readonly #file: DiagnosticFile
  readonly #maxQueueBytes: number
  readonly #maxBatchBytes: number
  readonly #closeTimeoutMs: number
  readonly #outputs = new Set<Writable>()
  readonly #captures = new Set<CapturedDiagnosticOutput>()
  readonly #flushWaiters: Array<{ target: number, resolve: () => void }> = []
  readonly #status: DesktopDiagnosticStatus = {
    accepted: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    unconfirmed: 0,
    pendingBytes: 0,
    lastError: null,
    state: 'open',
    closeTimedOut: false,
  }

  #queue: Buffer[] = []
  #sequence = 0
  #settled = 0
  #retryAt = 0
  #lossesPending = false
  #draining: Promise<void> | null = null
  #closing: Promise<DesktopDiagnosticStatus> | null = null

  constructor(options: DesktopDiagnosticLoggerOptions) {
    const maxFileBytes = options.maxFileBytes ?? APPLICATION_LOG_MAX_FILE_BYTES
    const maxFiles = options.maxFiles ?? APPLICATION_LOG_MAX_FILES
    this.#maxQueueBytes = options.maxQueueBytes ?? 2 * 1024 * 1024
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2000
    if ([maxFileBytes, this.#maxQueueBytes].some(value => !Number.isSafeInteger(value) || value < MAX_DIAGNOSTIC_RECORD_BYTES)
      || !Number.isSafeInteger(maxFiles) || maxFiles < 1
      || !Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError('Invalid diagnostic limits')
    }
    this.#maxBatchBytes = Math.min(maxFileBytes, 64 * 1024)
    this.#file = new DiagnosticFile(options.directory, maxFileBytes, maxFiles)
    this.#userHome = options.userHome
    this.#context = {
      launchId: randomUUID(),
      appVersion: options.appVersion,
      platform: process.platform,
      collectorPid: process.pid,
    }
  }

  get status(): DesktopDiagnosticStatus {
    return { ...this.#status }
  }

  get launchId(): string {
    return this.#context.launchId
  }

  record(input: DesktopDiagnosticEvent): boolean {
    if (this.#status.state !== 'open')
      return false
    return this.#enqueue(input)
  }

  createWritable(scope: DesktopDiagnosticScope, options: Partial<Pick<DesktopDiagnosticEvent, 'event' | 'level' | 'sourceId'>> = {}): Writable {
    const sourceId = randomUUID()
    const output = createDiagnosticOutput(
      message => this.#enqueue({ scope, sourceId, event: 'process.stderr', level: 'warn', ...options, message }),
      () => this.#drop(),
    )
    if (this.#status.state !== 'open') {
      output.end()
      return output
    }
    this.#outputs.add(output)
    output.once('close', () => this.#outputs.delete(output))
    return output
  }

  captureOutput(scope: DesktopDiagnosticScope, source: NodeJS.ReadableStream, sourceId?: string): void {
    if (this.#status.state !== 'open')
      return
    const capture = captureDiagnosticOutput(source, this.createWritable(scope, sourceId ? { sourceId } : {}), (error) => {
      this.#enqueue({ scope, sourceId, level: 'warn', event: 'process.stderr_failed', error })
    })
    this.#captures.add(capture)
    void capture.done.then(() => this.#captures.delete(capture))
  }

  async flush(): Promise<DesktopDiagnosticStatus> {
    const target = this.#status.accepted
    if (this.#settled < target)
      await new Promise<void>(resolve => this.#flushWaiters.push({ target, resolve }))
    return this.status
  }

  async flushWithin(timeoutMs = this.#closeTimeoutMs): Promise<DesktopDiagnosticStatus> {
    const target = this.#status.accepted
    if (this.#settled >= target)
      return this.status
    let timer: ReturnType<typeof setTimeout> | undefined
    let waiter: { target: number, resolve: () => void } | undefined
    try {
      await new Promise<void>((resolve) => {
        waiter = { target, resolve }
        this.#flushWaiters.push(waiter)
        timer = setTimeout(resolve, timeoutMs)
      })
    }
    finally {
      clearTimeout(timer)
      const index = waiter ? this.#flushWaiters.indexOf(waiter) : -1
      if (index >= 0)
        this.#flushWaiters.splice(index, 1)
    }
    return this.status
  }

  close(): Promise<DesktopDiagnosticStatus> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<DesktopDiagnosticStatus> {
    this.#status.state = 'closing'
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.#status.closeTimedOut = true
        resolve()
      }, this.#closeTimeoutMs)
    })
    const close = async () => {
      await Promise.all([...this.#captures].map(capture => capture.done))
      for (const output of this.#outputs)
        output.end()
      this.#reportLosses()
      await this.flush()
      await this.#draining
      await this.#file.close()
    }
    await Promise.race([close().catch(error => this.#noteError(error)), timedOut])
    clearTimeout(timer)
    for (const capture of this.#captures)
      capture.stop()
    for (const output of this.#outputs)
      output.end()
    this.#status.state = 'closed'
    if (this.#status.closeTimedOut) {
      this.#status.unconfirmed += this.#status.accepted - this.#settled
      this.#settled = this.#status.accepted
      this.#status.pendingBytes = 0
      this.#queue = []
      this.#resolveFlushes()
    }
    return this.status
  }

  #enqueue(input: DesktopDiagnosticEvent): boolean {
    if (this.#status.state === 'closed')
      return false
    if (performance.now() < this.#retryAt)
      return this.#drop()
    const line = encodeDiagnosticRecord(input, this.#context, ++this.#sequence, performance.now() - this.#startedAt, this.#userHome)
    if (!line || this.#status.pendingBytes + line.length > this.#maxQueueBytes)
      return this.#drop()
    this.#queue.push(line)
    this.#status.accepted++
    this.#status.pendingBytes += line.length
    this.#startDrain()
    return true
  }

  #startDrain(): void {
    this.#draining ??= Promise.resolve().then(() => this.#drain()).finally(() => {
      this.#draining = null
      if (this.#queue.length)
        this.#startDrain()
    })
  }

  async #drain(): Promise<void> {
    while (this.#queue.length) {
      const batch: Buffer[] = []
      let bytes = 0
      while (this.#queue.length && bytes + this.#queue[0]!.length <= this.#maxBatchBytes) {
        const line = this.#queue.shift()!
        bytes += line.length
        batch.push(line)
      }
      try {
        await this.#file.append(Buffer.concat(batch, bytes))
        if (this.#status.state === 'closed')
          return
        this.#status.written += batch.length
      }
      catch (error) {
        this.#noteError(error)
        if (this.#status.state === 'closed')
          return
        this.#status.failed += batch.length + this.#queue.length
        this.#settled += batch.length + this.#queue.length
        this.#status.pendingBytes = 0
        this.#queue = []
        this.#retryAt = performance.now() + 1000
        this.#lossesPending = true
        await this.#file.close().catch(error => this.#noteError(error))
        this.#resolveFlushes()
        return
      }
      this.#status.pendingBytes -= bytes
      this.#settled += batch.length
      this.#resolveFlushes()
      this.#reportLosses()
    }
  }

  #reportLosses(): void {
    if (!this.#lossesPending || this.#status.pendingBytes || performance.now() < this.#retryAt)
      return
    this.#lossesPending = false
    this.#enqueue({
      scope: 'desktop',
      level: 'warn',
      event: 'recorder.loss',
      recorderLoss: { dropped: this.#status.dropped, failed: this.#status.failed },
    })
  }

  #drop(): false {
    this.#status.dropped++
    this.#lossesPending = true
    return false
  }

  #noteError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Diagnostic I/O failure'
    this.#status.lastError = redactDiagnosticText(message, this.#userHome).slice(0, 1024)
  }

  #resolveFlushes(): void {
    for (let index = this.#flushWaiters.length - 1; index >= 0; index--) {
      if (this.#flushWaiters[index]!.target <= this.#settled)
        this.#flushWaiters.splice(index, 1)[0]!.resolve()
    }
  }
}
