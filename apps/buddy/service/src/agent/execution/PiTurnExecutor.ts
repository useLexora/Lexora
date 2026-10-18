import type { RunEventWriter } from '../../events/RunEventPorts'
import type { RunContinuityService } from '../../runs/RunContinuityService'
import type { RunRecord } from '../../storage/runRecord'
import type {
  PiEventBridge,
  PiEventBridgeSettlement,
  PiTurnEventChannel,
} from '../events/PiEventBridge'
import type { BuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import type { BuddySessionFactoryInput } from '../sessions/BuddySessionFactory'
import type {
  BuddySessionBinding,
  BuddySessionRegistry,
} from '../sessions/BuddySessionRegistry'
import type { ReusableBuddySession } from '../sessions/ReusableBuddySession'
import type { ExecutionContinuationPort, ExecutionMailboxReceipt } from './ExecutionContinuationPort'
import type { RunExecutionBackend, RunExecutionOutcome } from './RunExecutionBackend'
import type {
  StartBuddyCompactionInput,
  StartBuddyTurnInput,
} from './turnTypes'
import { diagnosticContext } from '../../diagnostics/diagnosticContext'
import { RunEventLogUnavailableError } from '../../events/RunEventFailure'
import { BuddyAgentRunError, readStableRunErrorCode } from '../../runs/runError'
import { CodemodeCleanupIncompleteError } from '../extensions/codemodeExtension'

export const AUTOMATION_SESSION_STARTUP_TIMEOUT_MS = 60_000

type PiTurnSessions = Pick<
  BuddySessionRegistry<ReusableBuddySession>,
  'getOrCreate' | 'invalidateSession' | 'acknowledgeRecovery'
>

export interface PiTurnExecutorOptions {
  automationSessionStartupTimeoutMs?: number
  eventLog: RunEventWriter
  piEvents: Pick<PiEventBridge, 'createCompaction' | 'createTurn'>
  continuity: Pick<RunContinuityService, 'bindSession' | 'clearForRun'>
  sessionFactory: (
    input: BuddySessionFactoryInput,
  ) => Promise<BuddySessionBinding<ReusableBuddySession>>
  sessions: PiTurnSessions
}

interface ExecutePiTurnInput {
  continuation: ExecutionContinuationPort
  identity: BuddySessionIdentity
  input: StartBuddyTurnInput
  onSessionActivated: (session: ReusableBuddySession) => void
  onSessionStartupTimeout: () => void
  run: RunRecord
  signal: AbortSignal
  timestamp: () => string
}

interface ExecutePiCompactionInput {
  identity: BuddySessionIdentity
  input: StartBuddyCompactionInput
  onSessionActivated: (session: ReusableBuddySession) => void
  run: RunRecord
  signal: AbortSignal
  timestamp: () => string
}

export interface InvalidatePiSessionContinuityInput {
  error: unknown
  identity: BuddySessionIdentity
  runId: string
}

export class PiTurnExecutor implements RunExecutionBackend {
  readonly #automationSessionStartupTimeoutMs: number
  readonly #eventLog: PiTurnExecutorOptions['eventLog']
  readonly #piEvents: PiTurnExecutorOptions['piEvents']
  readonly #continuity: PiTurnExecutorOptions['continuity']
  readonly #sessionFactory: PiTurnExecutorOptions['sessionFactory']
  readonly #sessions: PiTurnSessions

  constructor(options: PiTurnExecutorOptions) {
    this.#automationSessionStartupTimeoutMs = options.automationSessionStartupTimeoutMs
      ?? AUTOMATION_SESSION_STARTUP_TIMEOUT_MS
    this.#eventLog = options.eventLog
    this.#piEvents = options.piEvents
    this.#continuity = options.continuity
    this.#sessionFactory = options.sessionFactory
    this.#sessions = options.sessions
  }

  async executeTurn(execution: ExecutePiTurnInput): Promise<RunExecutionOutcome> {
    const { identity, input, run, signal } = execution
    const bindingPromise = this.#sessions.getOrCreate(
      identity,
      run.piSessionFile,
      () => this.#sessionFactory({
        blueprint: input.session,
        piSessionFile: run.piSessionFile,
        runId: run.id,
        signal,
        thinkingLevel: input.thinkingLevel,
      }),
    )
    const binding = identity.sessionMode === 'automation_background'
      ? await this.#withAutomationSessionStartupTimeout(
          bindingPromise,
          execution.onSessionStartupTimeout,
        )
      : await bindingPromise
    signal.throwIfAborted()
    if (!this.#continuity.bindSession(run.id, binding.piSessionFile))
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    await this.#recordSessionRecovery(run.id, identity, binding)
    signal.throwIfAborted()

    execution.onSessionActivated(binding.session)
    const piEvents = this.#piEvents.createTurn({
      conversationId: run.conversationId,
      branchId: run.branchId,
      canonicalRoot: input.session.canonicalRoot,
      model: run.model,
      provider: run.provider,
      runId: run.id,
      session: binding.session,
      timestamp: execution.timestamp,
    })
    const releaseTurn = await binding.session.activateTurn({
      contextWindow: run.contextWindow,
      generation: run.generation,
      deferQueuedInputs: true,
      flushProjectedEvents: () => piEvents.flush(),
      maxTokens: run.maxTokens,
      model: run.model,
      onToolExecutionAuthorized: event => piEvents.projectToolExecutionAuthorized(event),
      onToolExecutionDenied: event => piEvents.projectToolExecutionDenied(event),
      provider: run.provider,
      runId: run.id,
      serviceTier: input.serviceTier ?? null,
      signal,
      thinkingLevel: input.thinkingLevel,
    })
    const unsubscribe = piEvents.subscribe()
    const consumed = new Map<string, ExecutionMailboxReceipt>()
    let continuityFailure: unknown

    const runSegment = async (operation: () => Promise<void>): Promise<RunExecutionOutcome> => {
      let outcome: RunExecutionOutcome
      try {
        signal.throwIfAborted()
        await diagnosticContext.run({ ...diagnosticContext.getStore(), runId: run.id, conversationId: run.conversationId, branchId: run.branchId }, operation)
        await binding.session.waitForIdle()
        await piEvents.flush()
        outcome = readTurnOutcome(piEvents, signal)
      }
      catch (error) {
        await settlePiEventsAfterFailure(error, piEvents)
        continuityFailure = error
        outcome = outcomeFromError(error, signal)
      }
      if (!signal.aborted) {
        try {
          const snapshot = await execution.continuation.readPending()
          const receipts = await binding.session.readInternalMessageReceipts(snapshot.messages)
          await execution.continuation.acceptInContext(receipts)
          if (outcome.status === 'completed') {
            for (const receipt of receipts)
              consumed.set(JSON.stringify([receipt.sourceRunId, receipt.messageId]), receipt)
          }
        }
        catch (error) {
          await settlePiEventsAfterFailure(error, piEvents)
          continuityFailure = error
          outcome = outcomeFromError(error, signal)
        }
      }
      return outcome
    }

    try {
      let outcome = await runSegment(() => binding.session.prompt(input.userInput.prompt, {
        expandPromptTemplates: false,
        inputReference: input.userInput,
        source: 'rpc',
      }))
      outcome = await continueExecution({
        continuation: execution.continuation,
        consumed,
        outcome,
        runSegment,
        session: binding.session,
        signal,
      })
      try {
        await binding.session.finishTurn()
        await piEvents.flush()
      }
      catch (error) {
        await settlePiEventsAfterFailure(error, piEvents)
        continuityFailure = error
        outcome = { ...outcomeFromError(error, signal), closingGeneration: outcome.closingGeneration }
      }
      if (continuityFailure) {
        await this.invalidateSessionContinuityAfterFailure({ error: continuityFailure, identity, runId: run.id })
      }
      if (signal.aborted)
        return { status: 'cancelled', errorCode: null, closingGeneration: outcome.closingGeneration }
      return outcome
    }
    finally {
      unsubscribe()
      releaseTurn()
    }
  }

  async executeCompaction(
    execution: ExecutePiCompactionInput,
  ): Promise<RunExecutionOutcome> {
    const { identity, input, run, signal } = execution
    const binding = await this.#sessions.getOrCreate(
      identity,
      run.piSessionFile,
      () => this.#sessionFactory({
        blueprint: input.session,
        piSessionFile: run.piSessionFile,
        runId: run.id,
        signal,
        thinkingLevel: input.thinkingLevel,
      }),
    )
    signal.throwIfAborted()
    if (!this.#continuity.bindSession(run.id, binding.piSessionFile))
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    await this.#recordSessionRecovery(run.id, identity, binding)
    signal.throwIfAborted()

    if (!binding.session.canCompact())
      throw new BuddyAgentRunError('CONTEXT_COMPACTION_NOT_NEEDED')

    execution.onSessionActivated(binding.session)
    const releaseTurn = await binding.session.activateTurn({
      contextWindow: run.contextWindow,
      generation: run.generation,
      flushProjectedEvents: async () => {},
      maxTokens: run.maxTokens,
      model: run.model,
      onToolExecutionAuthorized: async () => {},
      onToolExecutionDenied: async () => {},
      provider: run.provider,
      runId: run.id,
      serviceTier: null,
      signal,
      thinkingLevel: input.thinkingLevel,
    })
    const piEvents = this.#piEvents.createCompaction({
      conversationId: run.conversationId,
      branchId: run.branchId,
      canonicalRoot: input.session.canonicalRoot,
      model: run.model,
      provider: run.provider,
      runId: run.id,
      session: binding.session,
      timestamp: execution.timestamp,
    })
    const unsubscribe = piEvents.subscribe()

    try {
      signal.throwIfAborted()
      const result = await diagnosticContext.run({ ...diagnosticContext.getStore(), runId: run.id, conversationId: run.conversationId, branchId: run.branchId }, () => binding.session.compact(
        input.customInstructions?.trim() || undefined,
      ))
      await binding.session.finishTurn()
      await piEvents.flush()
      await piEvents.recordCompactionResult(result)
    }
    catch (error) {
      await settlePiEventsAfterFailure(error, piEvents)
      await binding.session.finishTurn()
      if (signal.aborted || isAbortError(error))
        throw error
      if (readStableRunErrorCode(error) === 'SESSION_STORAGE_UNAVAILABLE')
        throw error
      throw new BuddyAgentRunError('COMPACTION_FAILED')
    }
    finally {
      unsubscribe()
      releaseTurn()
    }

    if (signal.aborted)
      return { errorCode: 'RUN_CANCELLED', status: 'cancelled' }
    return { status: 'completed' }
  }

  async invalidateSessionContinuityAfterFailure(
    input: InvalidatePiSessionContinuityInput,
  ): Promise<void> {
    const errorCode = readStableRunErrorCode(input.error)
    if (errorCode === 'SESSION_STORAGE_UNAVAILABLE')
      await this.#invalidateSessionContinuity(input.identity, input.runId)
    else if (errorCode === 'AUTOMATION_RUN_TIMEOUT' || input.error instanceof CodemodeCleanupIncompleteError)
      await this.#sessions.invalidateSession(input.identity)
  }

  async #recordSessionRecovery(
    runId: string,
    identity: BuddySessionIdentity,
    binding: BuddySessionBinding<ReusableBuddySession>,
  ): Promise<void> {
    if (!binding.recoveredFromProductHistory)
      return
    const degradation = binding.recoveryDegradation
    await this.#eventLog.appendBatch([
      {
        payload: { source: 'sqlite' },
        runId,
        type: 'session.recovered',
      },
      ...(degradation
        ? [{
            payload: {
              missingAttachmentCount: degradation.missingAttachmentIds.length,
              missingAttachmentIds: degradation.missingAttachmentIds,
              recoveredImageCount: degradation.recoveredImageCount,
              source: 'sqlite',
            },
            runId,
            type: 'session.recovery.degraded',
          }]
        : []),
    ])
    this.#sessions.acknowledgeRecovery(identity, binding)
  }

  async #withAutomationSessionStartupTimeout<T>(
    operation: Promise<T>,
    onTimeout: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout()
        reject(new BuddyAgentRunError('AUTOMATION_RUN_TIMEOUT'))
      }, this.#automationSessionStartupTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([operation, timeout])
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  async #invalidateSessionContinuity(
    identity: BuddySessionIdentity,
    runId: string,
  ): Promise<void> {
    this.#continuity.clearForRun(runId)
    await this.#sessions.invalidateSession(identity)
  }
}

async function continueExecution(input: {
  continuation: ExecutionContinuationPort
  consumed: Map<string, ExecutionMailboxReceipt>
  outcome: RunExecutionOutcome
  runSegment: (operation: () => Promise<void>) => Promise<RunExecutionOutcome>
  session: ReusableBuddySession
  signal: AbortSignal
}): Promise<RunExecutionOutcome> {
  const { continuation, consumed, session, signal } = input
  let outcome = input.outcome
  for (;;) {
    if (signal.aborted)
      outcome = { errorCode: null, status: 'cancelled' }
    const closing = await continuation.prepareClose({ outcome, consumedReceipts: [...consumed.values()] })
    if (closing.kind === 'sealed')
      return { ...outcome, closingGeneration: closing.closingGeneration }
    if (outcome.status === 'completed') {
      let snapshot
      try {
        snapshot = await continuation.readPending()
      }
      catch (error) {
        if (error instanceof RunEventLogUnavailableError || (!signal.aborted && !isAbortError(error)))
          throw error
        outcome = { errorCode: null, status: 'cancelled' }
        continue
      }
      if (snapshot.shouldResume && snapshot.messages.length) {
        let receipts: readonly ExecutionMailboxReceipt[] = []
        outcome = await input.runSegment(async () => {
          receipts = await session.appendInternalMessages(snapshot.messages)
          await continuation.acceptInContext(receipts)
          signal.throwIfAborted()
          await session.resumeInternal(receipts)
        })
        if (outcome.status === 'completed') {
          for (const receipt of receipts)
            consumed.set(JSON.stringify([receipt.sourceRunId, receipt.messageId]), receipt)
        }
        continue
      }
      if (snapshot.revision !== closing.revision)
        continue
    }
    try {
      await continuation.waitForChange({
        afterRevision: closing.revision,
        signal: outcome.status === 'completed' ? signal : undefined,
      })
    }
    catch (error) {
      if (error instanceof RunEventLogUnavailableError || !signal.aborted)
        throw error
      outcome = { errorCode: null, status: 'cancelled' }
    }
  }
}

function readTurnOutcome(channel: PiTurnEventChannel, signal: AbortSignal): RunExecutionOutcome {
  const { failureCode, failureMessage } = channel.outcome
  if (signal.aborted || failureCode === 'MODEL_REQUEST_ABORTED')
    return { errorCode: null, status: 'cancelled' }
  if (failureCode)
    return { errorCode: failureCode, errorMessage: failureMessage, status: 'failed' }
  return { status: 'completed' }
}

function outcomeFromError(error: unknown, signal: AbortSignal): RunExecutionOutcome {
  if (signal.aborted || isAbortError(error))
    return { errorCode: null, status: 'cancelled' }
  return { errorCode: readStableRunErrorCode(error), status: 'failed' }
}

async function settlePiEventsAfterFailure(
  executionError: unknown,
  channel: { settle: () => Promise<PiEventBridgeSettlement> },
): Promise<PiEventBridgeSettlement> {
  const settlement = await channel.settle()
  const fatalError = [
    executionError,
    settlement.eventError,
    settlement.writerError,
  ].find(candidate => candidate instanceof RunEventLogUnavailableError)
  if (fatalError)
    throw fatalError
  return settlement
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
