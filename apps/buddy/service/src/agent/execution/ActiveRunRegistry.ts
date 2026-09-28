import type { SkillReference } from '../../../../shared/skills/skillApi'
import type { RunRecord } from '../../storage/runRecord'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import type { BuddyTurnHandle } from './turnTypes'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { BuddyAgentRunError } from '../../runs/runError'

export interface ExecutionSettled {
  readonly conversationId: string
  readonly branchId: string
  readonly runId: string
  readonly executionId: string
  readonly cleanup: 'completed' | 'degraded'
  readonly stopping: boolean
}

export interface ActiveRunSession {
  steer?: (prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]) => boolean
  followUp?: (prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]) => boolean
  abort: () => Promise<void>
  abortCompaction: () => void
}

export interface ActiveRunContext {
  activateSession: (session: ActiveRunSession) => void
  getCancellationCode: () => string | null
  identity: BuddySessionIdentity
  requestCancellation: (errorCode: string) => void
  markCleanupDegraded: () => void
  runId: string
  signal: AbortSignal
}

interface ActiveRunState {
  cancellationCode: string | null
  controller: AbortController
  identity: BuddySessionIdentity
  runId: string
  session: ActiveRunSession | null
}

interface ActiveRunExecution {
  completion: Promise<RunRecord>
  state: ActiveRunState
}

interface StartActiveRunInput {
  execute: (context: ActiveRunContext) => Promise<RunRecord>
  identity: BuddySessionIdentity
  runId: string
}

export class ActiveRunRegistry {
  readonly #executions = new Map<string, ActiveRunExecution>()
  readonly #degradedCleanup = new Set<string>()
  readonly #settled: Emitter<ExecutionSettled>
  readonly onDidSettle: Emitter<ExecutionSettled>['event']

  #disposed = false

  constructor(onObserverError: (error: unknown) => void = () => {}) {
    this.#settled = new Emitter(onObserverError)
    this.onDidSettle = this.#settled.event
  }

  hasActiveExecution(conversationId: string): boolean {
    return [...this.#executions.values()].some(execution => execution.state.identity.conversationId === conversationId)
  }

  get isStopping(): boolean {
    return this.#disposed
  }

  hasDegradedCleanup(conversationId: string): boolean {
    return this.#degradedCleanup.has(conversationId)
  }

  start(input: StartActiveRunInput): BuddyTurnHandle {
    if (this.#disposed)
      throw new DOMException('Runtime is stopping', 'AbortError')
    if (this.#executions.has(input.runId))
      throw new BuddyAgentRunError('VALIDATION_FAILED')

    const executionId = randomUUID()
    let cleanup: ExecutionSettled['cleanup'] = 'completed'
    const state: ActiveRunState = {
      cancellationCode: null,
      controller: new AbortController(),
      identity: { ...input.identity },
      runId: input.runId,
      session: null,
    }
    const context: ActiveRunContext = {
      activateSession: session => this.#activateSession(state, session),
      getCancellationCode: () => state.cancellationCode,
      identity: state.identity,
      requestCancellation: errorCode => this.#requestCancellation(state, errorCode),
      markCleanupDegraded: () => { cleanup = 'degraded' },
      runId: state.runId,
      signal: state.controller.signal,
    }
    const completion = Promise.resolve()
      .then(() => input.execute(context))
      .catch((error) => {
        cleanup = 'degraded'
        throw error
      })
      .finally(() => {
        const execution = this.#executions.get(state.runId)
        if (execution?.state === state)
          this.#executions.delete(state.runId)
        if (cleanup === 'degraded')
          this.#degradedCleanup.add(state.identity.conversationId)
        else
          this.#degradedCleanup.delete(state.identity.conversationId)
        this.#settled.fire(copyEventSnapshot({
          conversationId: state.identity.conversationId,
          branchId: state.identity.branchId,
          runId: state.runId,
          executionId,
          cleanup,
          stopping: this.#disposed,
        }))
      })
    this.#executions.set(state.runId, { completion, state })
    return { completion, runId: state.runId }
  }

  steer(runId: string, prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]): boolean {
    const state = this.#executions.get(runId)?.state
    return state && !state.controller.signal.aborted ? state.session?.steer?.(prepare, skills) ?? false : false
  }

  followUp(runId: string, prepare: () => BuddyInputReferenceV1, skills?: readonly SkillReference[]): boolean {
    const state = this.#executions.get(runId)?.state
    return state && !state.controller.signal.aborted ? state.session?.followUp?.(prepare, skills) ?? false : false
  }

  async cancel(runId: string, errorCode = 'RUN_CANCELLED'): Promise<boolean> {
    const execution = this.#executions.get(runId)
    if (!execution)
      return false
    this.#requestCancellation(execution.state, errorCode)
    await this.#abortSession(execution.state.session)
    await execution.completion.catch(() => {})
    return true
  }

  cancelAndWaitForConversation(conversationId: string): Promise<number> {
    return this.#cancelAndWait(
      execution => execution.state.identity.conversationId === conversationId,
    )
  }

  cancelAndWaitForRoot(canonicalRoot: string): Promise<number> {
    return this.#cancelAndWait(
      execution => execution.state.identity.canonicalRoot === canonicalRoot,
    )
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const executions = [...this.#executions.values()]
    for (const execution of executions)
      this.#requestCancellation(execution.state, 'RUN_CANCELLED')
    await Promise.allSettled(
      executions.map(execution => this.#abortSession(execution.state.session)),
    )
    await Promise.allSettled(executions.map(execution => execution.completion))
    this.#executions.clear()
    this.#degradedCleanup.clear()
    this.#settled.dispose()
  }

  async #cancelAndWait(
    predicate: (execution: ActiveRunExecution) => boolean,
  ): Promise<number> {
    const executions = [...this.#executions.values()].filter(predicate)
    for (const execution of executions)
      this.#requestCancellation(execution.state, 'RUN_CANCELLED')
    await Promise.allSettled(executions.map(async (execution) => {
      await this.#abortSession(execution.state.session)
      await execution.completion
    }))
    return executions.length
  }

  #activateSession(state: ActiveRunState, session: ActiveRunSession): void {
    state.session = session
    if (state.controller.signal.aborted)
      void this.#abortSession(session)
  }

  async #abortSession(session: ActiveRunSession | null): Promise<void> {
    if (!session)
      return
    try {
      session.abortCompaction()
    }
    catch {}
    try {
      await session.abort()
    }
    catch {}
  }

  #requestCancellation(state: ActiveRunState, errorCode: string): void {
    if (state.controller.signal.aborted)
      return
    state.cancellationCode = errorCode
    state.controller.abort()
  }
}
