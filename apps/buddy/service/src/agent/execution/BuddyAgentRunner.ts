import type { SkillReference } from '../../../../shared/skills/skillApi'
import type { RunLifecycleService } from '../../runs/RunLifecycleService'
import type { RunRecord } from '../../storage/runRecord'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddySessionRegistry, DisposableBuddySession } from '../sessions/BuddySessionRegistry'
import type { ActiveRunContext } from './ActiveRunRegistry'
import type { ExecutionLifecyclePort } from './ExecutionLifecyclePort'
import type { RunExecutionBackend, RunExecutionOutcome } from './RunExecutionBackend'
import type {
  BuddyTurnHandle,
  StartBuddyCompactionInput,
  StartBuddyTurnInput,
} from './turnTypes'
import { RunEventLogUnavailableError } from '../../events/RunEventFailure'
import { BuddyAgentRunError, readStableRunErrorCode } from '../../runs/runError'
import { toBuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import { ActiveRunRegistry } from './ActiveRunRegistry'

export interface BuddyAgentRunnerOptions {
  executor: RunExecutionBackend
  executions: ExecutionLifecyclePort
  lifecycle: Pick<RunLifecycleService, 'find' | 'start'>
  releaseRunResources?: (runId: string) => void | Promise<void>
  onObserverError?: (error: unknown) => void
  sessions: Pick<BuddySessionRegistry<DisposableBuddySession>, 'withConversationRun' | 'dispose'>
}

export class BuddyAgentRunner {
  readonly #activeRuns: ActiveRunRegistry
  readonly onDidSettle: ActiveRunRegistry['onDidSettle']
  readonly #executor: BuddyAgentRunnerOptions['executor']
  readonly #executions: ExecutionLifecyclePort
  readonly #lifecycle: BuddyAgentRunnerOptions['lifecycle']
  readonly #releaseRunResources: NonNullable<BuddyAgentRunnerOptions['releaseRunResources']>
  readonly #sessions: Pick<BuddySessionRegistry<DisposableBuddySession>, 'withConversationRun' | 'dispose'>
  #lastTimestamp = 0

  constructor(options: BuddyAgentRunnerOptions) {
    this.#executor = options.executor
    this.#executions = options.executions
    this.#activeRuns = new ActiveRunRegistry(options.onObserverError)
    this.onDidSettle = this.#activeRuns.onDidSettle
    this.#lifecycle = options.lifecycle
    this.#releaseRunResources = options.releaseRunResources ?? (() => {})
    this.#sessions = options.sessions
  }

  startTurn(input: StartBuddyTurnInput): BuddyTurnHandle {
    if (!input.userInput.prompt.trim())
      throw new BuddyAgentRunError('VALIDATION_FAILED')

    const runId = input.runId
    const run = this.#lifecycle.find(runId)
    const session = input.session
    if (
      !run
      || run.status !== 'queued'
      || (run.purpose !== 'chat' && run.purpose !== 'automation')
      || run.conversationId !== session.conversationId
      || run.branchId !== session.branchId
      || run.approvalPolicy !== session.approvalPolicy
      || run.executionProfile !== session.executionProfile
      || session.sessionMode !== (run.purpose === 'automation'
        ? 'automation_background'
        : 'interactive')
    ) {
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    }

    const identity = toBuddySessionIdentity(session)
    return this.#activeRuns.start({
      execute: execution => this.#withConversationRun(execution, () => this.#executeTurn(input, execution)),
      identity,
      runId,
    })
  }

  startCompaction(input: StartBuddyCompactionInput): BuddyTurnHandle {
    const run = this.#lifecycle.find(input.runId)
    const session = input.session
    if (
      !run
      || run.status !== 'queued'
      || run.conversationId !== session.conversationId
      || run.branchId !== session.branchId
      || run.approvalPolicy !== session.approvalPolicy
      || run.executionProfile !== session.executionProfile
      || run.purpose !== 'conversation.compaction'
      || !run.piSessionFile
      || session.sessionMode !== 'interactive'
    ) {
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    }

    const identity = toBuddySessionIdentity(session)
    return this.#activeRuns.start({
      execute: execution => this.#withConversationRun(execution, () => this.#executeCompaction(input, run, execution)),
      identity,
      runId: run.id,
    })
  }

  steer(runId: string, prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]): boolean {
    return this.#activeRuns.steer(runId, prepare, skills)
  }

  hasActiveExecution(conversationId: string): boolean {
    return this.#activeRuns.hasActiveExecution(conversationId)
  }

  get hasActiveExecutions(): boolean {
    return this.#activeRuns.hasActiveExecutions
  }

  get isStopping(): boolean {
    return this.#activeRuns.isStopping
  }

  hasDegradedCleanup(conversationId: string): boolean {
    return this.#activeRuns.hasDegradedCleanup(conversationId)
  }

  followUp(runId: string, prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]): boolean {
    return this.#activeRuns.followUp(runId, prepare, skills)
  }

  async interruptExecution(runId: string, errorCode = 'RUN_CANCELLED'): Promise<boolean> {
    return this.#activeRuns.cancel(runId, errorCode)
  }

  async cancel(runId: string, errorCode = 'RUN_CANCELLED'): Promise<boolean> {
    return this.#executions.cancel(runId, errorCode, id => this.#activeRuns.cancel(id, errorCode))
  }

  cancelAndWaitForConversation(conversationId: string): Promise<number> {
    return this.#executions.cancelAll({ conversationId }, id => this.#activeRuns.cancel(id))
  }

  cancelAndWaitForRoot(canonicalRoot: string): Promise<number> {
    return this.#executions.cancelAll({ runIds: this.#activeRuns.activeRunIds(canonicalRoot) }, id => this.#activeRuns.cancel(id))
  }

  async dispose(): Promise<void> {
    this.#activeRuns.stopAccepting()
    const failures: unknown[] = []
    for (const cleanup of [() => this.#executions.cancelAll({}, id => this.#activeRuns.cancel(id)), () => this.#activeRuns.dispose(), () => this.#sessions.dispose()]) {
      try {
        await cleanup()
      }
      catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Execution backend cleanup failed')
  }

  async #withConversationRun(execution: ActiveRunContext, operation: () => Promise<RunExecutionOutcome>): Promise<RunRecord> {
    let outcome: RunExecutionOutcome | null = null
    let fatal = false
    const handleError = async (error: unknown) => {
      if (error instanceof RunEventLogUnavailableError) {
        fatal = true
        return
      }
      outcome = await this.#outcomeFromError(execution, error)
    }
    try {
      await this.#sessions.withConversationRun(
        execution.identity,
        execution.runId,
        execution.signal,
        async () => {
          try {
            outcome = await operation()
          }
          catch (error) {
            await handleError(error)
          }
        },
        (result) => {
          if (result.cleanup === 'degraded')
            execution.markCleanupDegraded()
        },
      )
    }
    catch (error) {
      await handleError(error)
    }
    finally {
      try {
        await this.#releaseRunResources(execution.runId)
      }
      catch {
        execution.markCleanupDegraded()
      }
    }
    if (fatal) {
      const run = this.#lifecycle.find(execution.runId)
      if (!run)
        throw new BuddyAgentRunError('RUN_NOT_FOUND')
      return run
    }
    const result: RunExecutionOutcome = outcome ?? { status: 'failed', errorCode: 'AGENT_RUN_FAILED' }
    try {
      return await this.#executions.finalize({ runId: execution.runId, outcome: withCancellationCode(result, execution.getCancellationCode()), cleanup: execution.getCleanupState() })
    }
    catch (error) {
      if (!(error instanceof RunEventLogUnavailableError))
        throw error
      const run = this.#lifecycle.find(execution.runId)
      if (!run)
        throw new BuddyAgentRunError('RUN_NOT_FOUND')
      return run
    }
  }

  async #executeTurn(
    input: StartBuddyTurnInput,
    execution: ActiveRunContext,
  ): Promise<RunExecutionOutcome> {
    const { identity, runId, signal } = execution
    signal.throwIfAborted()
    const continuation = await this.#executions.begin(runId, signal)
    signal.throwIfAborted()
    const run = await this.#lifecycle.start({
      expectedPurposes: ['automation', 'chat'],
      payload: createRunStartedPayload(input),
      runId,
      startedAt: this.#timestamp(),
    })
    const outcome = await this.#executor.executeTurn({
      continuation,
      identity,
      input,
      onSessionActivated: execution.activateSession,
      onSessionStartupTimeout: () => execution.requestCancellation('AUTOMATION_RUN_TIMEOUT'),
      run,
      signal,
      timestamp: () => this.#timestamp(),
    })
    return outcome
  }

  async #executeCompaction(
    input: StartBuddyCompactionInput,
    run: RunRecord,
    execution: ActiveRunContext,
  ): Promise<RunExecutionOutcome> {
    execution.signal.throwIfAborted()
    const startedRun = await this.#lifecycle.start({
      expectedPurposes: ['conversation.compaction'],
      payload: createRunStartedPayload(input),
      runId: run.id,
      startedAt: this.#timestamp(),
    })
    const outcome = await this.#executor.executeCompaction({
      identity: execution.identity,
      input,
      onSessionActivated: execution.activateSession,
      run: startedRun,
      signal: execution.signal,
      timestamp: () => this.#timestamp(),
    })
    return outcome
  }

  async #outcomeFromError(
    execution: ActiveRunContext,
    error: unknown,
  ): Promise<RunExecutionOutcome> {
    await this.#executor.invalidateSessionContinuityAfterFailure({
      error,
      identity: execution.identity,
      runId: execution.runId,
    })
    if (execution.signal.aborted || isAbortError(error))
      return { status: 'cancelled', errorCode: execution.getCancellationCode() ?? 'RUN_CANCELLED' }
    return { status: 'failed', errorCode: readStableRunErrorCode(error) }
  }

  #timestamp(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1)
    return new Date(this.#lastTimestamp).toISOString()
  }
}

function createRunStartedPayload(
  input: StartBuddyTurnInput | StartBuddyCompactionInput,
): Record<string, unknown> {
  const { session } = input
  if (!session.space)
    return {}

  return {
    spaceSnapshot: {
      additionalDirectoryBindings: session.space.additionalDirectoryBindings,
      canonicalRoot: session.canonicalRoot,
      grantRevision: session.grantRevision,
      memoryScope: session.space.memoryScope,
      primaryDirectoryBinding: session.space.primaryDirectoryBinding,
      spaceId: session.space.id,
      resourceRevision: session.resources.revision,
    },
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function withCancellationCode(outcome: RunExecutionOutcome, cancellationCode: string | null): RunExecutionOutcome {
  return outcome.status === 'cancelled'
    ? { ...outcome, errorCode: outcome.errorCode ?? cancellationCode ?? 'RUN_CANCELLED' }
    : outcome
}
