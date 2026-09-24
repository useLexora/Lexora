import type { RunEventWriter } from '../../events/RunEventPorts'
import type { RunRecord } from '../../storage/runRecord'
import type { RunRepository } from '../../storage/runRepository'
import type {
  PiEventBridge,
  PiEventBridgeSettlement,
} from '../events/PiEventBridge'
import type { BuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import type { BuddySessionFactoryInput } from '../sessions/BuddySessionFactory'
import type {
  BuddySessionBinding,
  BuddySessionRegistry,
} from '../sessions/BuddySessionRegistry'
import type { ReusableBuddySession } from '../sessions/ReusableBuddySession'
import type { RunExecutionBackend, RunExecutionOutcome } from './RunExecutionBackend'
import type {
  StartBuddyCompactionInput,
  StartBuddyTurnInput,
} from './turnTypes'
import { diagnosticContext } from '../../diagnostics/diagnosticContext'
import { RunEventLogFatalError } from '../../events/RunEventFailure'
import { BuddyAgentRunError, readStableRunErrorCode } from '../../runs/runError'

export const AUTOMATION_SESSION_STARTUP_TIMEOUT_MS = 60_000

type PiTurnSessions = Pick<
  BuddySessionRegistry<ReusableBuddySession>,
  'getOrCreate' | 'invalidateSession'
>

export interface PiTurnExecutorOptions {
  automationSessionStartupTimeoutMs?: number
  eventLog: RunEventWriter
  piEvents: Pick<PiEventBridge, 'createCompaction' | 'createTurn'>
  runs: Pick<RunRepository, 'bindSession' | 'clearSessionBindings' | 'findById'>
  sessionFactory: (
    input: BuddySessionFactoryInput,
  ) => Promise<BuddySessionBinding<ReusableBuddySession>>
  sessions: PiTurnSessions
}

interface ExecutePiTurnInput {
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
  readonly #runs: PiTurnExecutorOptions['runs']
  readonly #sessionFactory: PiTurnExecutorOptions['sessionFactory']
  readonly #sessions: PiTurnSessions

  constructor(options: PiTurnExecutorOptions) {
    this.#automationSessionStartupTimeoutMs = options.automationSessionStartupTimeoutMs
      ?? AUTOMATION_SESSION_STARTUP_TIMEOUT_MS
    this.#eventLog = options.eventLog
    this.#piEvents = options.piEvents
    this.#runs = options.runs
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
    if (!this.#runs.bindSession(run.id, binding.piSessionFile))
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    await this.#recordSessionRecovery(run.id, binding)
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

    try {
      signal.throwIfAborted()
      await diagnosticContext.run({ ...diagnosticContext.getStore(), runId: run.id, conversationId: run.conversationId, branchId: run.branchId }, () => binding.session.prompt(input.userInput.prompt, {
        expandPromptTemplates: false,
        images: input.userInput.images.map(image => ({
          data: '',
          mimeType: image.mimeType,
          type: 'image',
        })),
        inputReference: input.userInput,
        source: 'rpc',
      }))
      await binding.session.waitForIdle()
      await piEvents.flush()
    }
    catch (error) {
      const { eventError, writerError } = await settlePiEventsAfterFailure(
        error,
        piEvents,
      )
      const outcome = piEvents.outcome
      if (
        readStableRunErrorCode(error) === 'SESSION_STORAGE_UNAVAILABLE'
        && !signal.aborted
        && !outcome.failureCode
        && outcome.finalAssistantAnswerProjected
        && eventError === null
        && writerError === null
      ) {
        await this.#eventLog.append({
          payload: {
            errorCode: 'SESSION_STORAGE_UNAVAILABLE',
            source: 'pi_session',
          },
          runId: run.id,
          type: 'session.continuity.degraded',
        })
        await this.#invalidateSessionContinuity(identity, run.id)
        return { status: 'completed' }
      }
      throw error
    }
    finally {
      unsubscribe()
      releaseTurn()
    }

    const { failureCode, failureMessage } = piEvents.outcome
    if (signal.aborted || failureCode === 'MODEL_REQUEST_ABORTED')
      return { errorCode: null, status: 'cancelled' }
    if (failureCode) {
      return {
        errorCode: failureCode,
        errorMessage: failureMessage,
        status: 'failed',
      }
    }
    return { status: 'completed' }
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
    if (!this.#runs.bindSession(run.id, binding.piSessionFile))
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    await this.#recordSessionRecovery(run.id, binding)
    signal.throwIfAborted()

    if (!binding.session.canCompact())
      throw new BuddyAgentRunError('CONTEXT_COMPACTION_NOT_NEEDED')

    execution.onSessionActivated(binding.session)
    const releaseTurn = await binding.session.activateTurn({
      contextWindow: run.contextWindow,
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
      await piEvents.flush()
      await piEvents.recordCompactionResult(result)
    }
    catch (error) {
      await settlePiEventsAfterFailure(error, piEvents)
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
    else if (errorCode === 'AUTOMATION_RUN_TIMEOUT')
      await this.#sessions.invalidateSession(input.identity)
  }

  async #recordSessionRecovery(
    runId: string,
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
    binding.recoveredFromProductHistory = false
    binding.recoveryDegradation = undefined
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
    const run = this.#runs.findById(runId)
    if (run?.piSessionFile) {
      this.#runs.clearSessionBindings(
        run.conversationId,
        run.branchId,
        run.piSessionFile,
      )
    }
    await this.#sessions.invalidateSession(identity)
  }
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
  ].find(candidate => candidate instanceof RunEventLogFatalError)
  if (fatalError)
    throw fatalError
  return settlement
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
