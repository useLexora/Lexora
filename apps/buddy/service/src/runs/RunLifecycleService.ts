import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { AppendBuddyRunEventInput } from '../events/BuddyRunEvent'
import type { RunEventMaintenance, RunEventWriter } from '../events/RunEventPorts'
import type { RunPurpose, RunRecord, RunStatus } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { RunEventLogFatalError } from '../events/RunEventFailure'
import { BuddyAgentRunError, readStableRunErrorCode } from './runError'

type TerminalRunStatus = Extract<RunStatus, 'cancelled' | 'completed' | 'failed'>

export type RunSqlReconciliation = Readonly<{
  runId: string
  conversationId: string
  branchId: string
  status: TerminalRunStatus
  errorCode: string | null
  completedAt: string
}>

export interface StartRunInput {
  expectedPurposes: readonly RunPurpose[]
  payload: Record<string, unknown>
  runId: string
  startedAt: string
}

export interface FinalizeRunInput {
  completedAt: string
  errorCode: string | null
  errorMessage?: string
  precedingEvents?: readonly AppendBuddyRunEventInput[]
  runId: string
  status: TerminalRunStatus
}

export interface RunLifecycleServiceOptions {
  record?: ApplicationDiagnosticReporter
  eventLog: Pick<RunEventWriter, 'append' | 'appendBatch'>
    & Pick<RunEventMaintenance, 'compactTerminalRun'>
  repository: Pick<
    RunRepository,
    'findById' | 'markRunning' | 'reconcileTerminal'
  >
}

export class RunLifecycleService {
  readonly #reconciled: Emitter<RunSqlReconciliation>
  readonly onDidReconcile: Emitter<RunSqlReconciliation>['event']
  readonly #eventLog: RunLifecycleServiceOptions['eventLog']
  readonly #repository: RunLifecycleServiceOptions['repository']
  readonly #pending = new Set<Promise<unknown>>()
  #stopping = false

  constructor(options: RunLifecycleServiceOptions) {
    this.#reconciled = new Emitter(() => safeDiagnosticReporter(options.record)({ event: 'observer.failed', component: 'runtime.run_lifecycle', level: 'warn' }))
    this.onDidReconcile = this.#reconciled.event
    this.#eventLog = options.eventLog
    this.#repository = options.repository
  }

  find(runId: string): RunRecord | null {
    return this.#repository.findById(runId)
  }

  start(input: StartRunInput): Promise<RunRecord> {
    return this.#run(() => this.#start(structuredClone(input)))
  }

  async #start(input: StartRunInput): Promise<RunRecord> {
    const run = this.#requireRun(input.runId)
    if (
      run.status !== 'queued'
      || !input.expectedPurposes.includes(run.purpose)
      || !this.#repository.markRunning(run.id, input.startedAt)
    ) {
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
    }
    await this.#eventLog.append({
      createdAt: input.startedAt,
      payload: input.payload,
      runId: run.id,
      type: 'run.started',
    })
    return this.#requireRun(run.id)
  }

  async failBeforeStart(runId: string, error: unknown): Promise<RunRecord | null> {
    const run = this.#repository.findById(runId)
    if (!run || run.status !== 'queued')
      return null
    return this.finalize({
      completedAt: new Date().toISOString(),
      errorCode: error instanceof Error && error.name === 'AbortError' ? 'RUN_CANCELLED' : readStableRunErrorCode(error),
      runId,
      status: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
    })
  }

  finalize(input: FinalizeRunInput): Promise<RunRecord> {
    return this.#run(() => this.#finalize(structuredClone(input)))
  }

  async #finalize(input: FinalizeRunInput): Promise<RunRecord> {
    const existing = this.#requireRun(input.runId)
    if (isTerminal(existing.status)) {
      if (existing.status === input.status)
        return existing
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
    }

    let { errorCode, status } = input
    let terminalEventPersisted = true
    const terminalEvent: AppendBuddyRunEventInput = {
      createdAt: input.completedAt,
      payload: {
        ...(errorCode ? { errorCode } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
      runId: input.runId,
      type: `run.${status}`,
    }
    try {
      if (input.precedingEvents?.length) {
        await this.#eventLog.appendBatch([
          ...input.precedingEvents,
          terminalEvent,
        ])
      }
      else {
        await this.#eventLog.append(terminalEvent)
      }
    }
    catch (error) {
      if (error instanceof RunEventLogFatalError)
        throw error
      terminalEventPersisted = false
      status = 'failed'
      errorCode = 'EVENT_LOG_FAILED'
    }
    if (!this.#repository.reconcileTerminal(
      input.runId,
      status,
      input.completedAt,
      errorCode,
    )) {
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
    }
    const run = this.#requireRun(input.runId)
    if (!terminalEventPersisted) {
      this.#reconciled.fire(copyEventSnapshot({
        runId: run.id,
        conversationId: run.conversationId,
        branchId: run.branchId,
        errorCode: run.errorCode,
        status,
        completedAt: input.completedAt,
      }))
    }
    if (terminalEventPersisted) {
      try {
        await this.#eventLog.compactTerminalRun(input.runId)
      }
      catch (error) {
        if (error instanceof RunEventLogFatalError)
          throw error
      }
    }
    return run
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled([...this.#pending])
    this.#reconciled.dispose()
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new Error('Run lifecycle service is stopped'))
    const accepted = Promise.withResolvers<T>()
    this.#pending.add(accepted.promise)
    void accepted.promise.finally(() => this.#pending.delete(accepted.promise)).catch(() => {})
    try {
      void operation().then(accepted.resolve, accepted.reject)
    }
    catch (error) {
      accepted.reject(error)
    }
    return accepted.promise
  }

  #requireRun(runId: string): RunRecord {
    const run = this.#repository.findById(runId)
    if (!run)
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    return run
  }
}

function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}
