import type { ExecutionMailboxDraft, ExecutionMailboxReceipt } from '../../../../shared/executions/executionApi'
import type { MutationCoordinator } from '../../changes/MutationCoordinator'
import type { RunEventAvailability, RunEventObservation, RunEventWriter } from '../../events/RunEventPorts'
import type { RunLifecycleService } from '../../runs/RunLifecycleService'
import type { AdmitChildExecutionInput, ExecutionRepository, ExecutionStateRecord } from '../../storage/executionRepository'
import type { MailboxRepository } from '../../storage/mailboxRepository'
import type { RunRecord } from '../../storage/runRecord'
import type { ExecutionContinuationPort, ExecutionInputState } from './ExecutionContinuationPort'
import type { ExecutionLifecyclePort } from './ExecutionLifecyclePort'
import type { RunExecutionOutcome } from './RunExecutionBackend'
import type { BuddyTurnHandle } from './turnTypes'
import { Emitter } from '../../../../shared/events/Emitter'
import { isExecutionProgress } from '../../../../shared/executions/executionApi'
import { RunEventCorruptionError, RunEventLogUnavailableError } from '../../events/RunEventFailure'
import { readStableRunErrorCode } from '../../runs/runError'
import { ExecutionAdmissionError, executionFence } from '../../storage/executionRepository'
import { previewExecutionResult } from './readExecutionResult'

interface Preparation {
  controller: AbortController
  settled: Promise<void>
  release: () => void
}

export interface ExecutionCoordinatorOptions {
  availability?: Pick<RunEventAvailability, 'assertRunExecutable'>
  executions: ExecutionRepository
  mailbox: MailboxRepository
  events: RunEventWriter & RunEventObservation
  lifecycle: Pick<RunLifecycleService, 'finalize'>
  mutations: Pick<MutationCoordinator, 'waitForRun' | 'getRunState'>
  readResult: (runId: string) => string | Promise<string>
  launchChild: (runId: string) => Promise<BuddyTurnHandle>
  stopExecution: (runId: string) => Promise<boolean>
  listIncomplete: () => readonly RunRecord[]
  getFileAccessCeiling?: (runId: string) => 'read_only' | undefined
  onObserverError?: (error: unknown) => void
  hostShellSupervision?: boolean
  recoverQuarantinedRun?: (runId: string) => boolean
  followUp?: (runId: string, signal: AbortSignal) => Promise<boolean>
}

class ShellSupervisionUnavailableError extends Error {
  readonly code = 'SHELL_SUPERVISION_UNAVAILABLE'

  constructor() {
    super('Shell descendants cannot be supervised on this platform. Use file tools during delegation, or complete shell work in a separate task.')
    this.name = 'ShellSupervisionUnavailableError'
  }
}

export class ExecutionCoordinator implements ExecutionLifecyclePort {
  readonly #options: ExecutionCoordinatorOptions
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly #revisions = new Map<string, number>()
  readonly #inputs = new Map<string, ExecutionInputState>()
  readonly #changes: Emitter<{ rootRunId: string }>
  readonly #preparations = new Map<string, Preparation>()
  readonly #children = new Map<string, Promise<RunRecord>>()
  readonly #uncontainedShellRoots = new Set<string>()
  readonly #subscription: ReturnType<RunEventObservation['onDidCommit']>
  readonly onDidChange: Emitter<{ rootRunId: string }>['event']
  #stopped = false

  constructor(options: ExecutionCoordinatorOptions) {
    this.#options = options
    this.#changes = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#changes.event
    this.#subscription = options.events.onDidCommit((event) => {
      const execution = options.executions.find(event.runId)
      if (execution)
        this.#changed(execution.run.rootRunId)
    })
  }

  prepare(runId: string, signal?: AbortSignal): { signal: AbortSignal, release: () => void } {
    signal?.throwIfAborted()
    const current = this.#require(runId)
    if (this.#stopped || current.cancelRequestedAt || this.#preparations.has(runId))
      throw new ExecutionAdmissionError('stale')
    if (this.#options.getFileAccessCeiling?.(runId) === 'read_only')
      this.#options.executions.setFileAccessCeiling(runId)
    if (current.phase === 'queued')
      this.#options.executions.beginPreparing(this.#fence(current))
    else if (current.phase !== 'preparing')
      throw new ExecutionAdmissionError('stale')
    const controller = new AbortController()
    const settled = Promise.withResolvers<void>()
    const cancel = () => controller.abort(signal?.reason)
    const release = () => {
      signal?.removeEventListener('abort', cancel)
      if (this.#preparations.get(runId)?.controller === controller)
        this.#preparations.delete(runId)
      settled.resolve()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    this.#preparations.set(runId, { controller, settled: settled.promise, release })
    this.#changed(current.run.rootRunId)
    return { signal: controller.signal, release }
  }

  async begin(runId: string, signal: AbortSignal): Promise<ExecutionContinuationPort> {
    const accepted = this.#require(runId)
    await this.#claimWorking(runId, signal)
    return {
      bindInputs: (state) => {
        this.#inputs.set(runId, state)
        return () => {
          if (this.#inputs.get(runId) === state)
            this.#inputs.delete(runId)
        }
      },
      acceptInput: (deliver) => {
        const current = this.#require(runId)
        if (this.#stopped || signal.aborted || current.cancelRequestedAt || current.run.generation !== accepted.run.generation
          || !['working', 'waiting'].includes(current.phase)) {
          return false
        }
        if (!deliver())
          return false
        this.#changed(current.run.rootRunId)
        return true
      },
      followUp: () => this.#options.followUp?.(runId, signal) ?? Promise.resolve(false),
      readPending: async () => {
        signal.throwIfAborted()
        const current = this.#require(runId)
        if (current.run.generation !== accepted.run.generation || current.cancelRequestedAt)
          throw new DOMException('Execution has been cancelled', 'AbortError')
        this.#options.executions.assertCurrent(this.#fence(current))
        const messages = this.#options.mailbox.listUnconsumed(runId)
        const shouldResume = messages.length > 0 && !(messages.every(isExecutionProgress)
          && this.#options.executions.listTree(current.run.rootRunId).some(child => child.run.parentRunId === runId && child.phase !== 'closed'))
        if ((shouldResume || this.#inputs.get(runId)?.hasPendingInput()) && current.phase === 'waiting')
          await this.#claimWorking(runId, signal)
        return { revision: this.#revision(current.run.rootRunId), messages, shouldResume }
      },
      acceptInContext: receipts => this.#serialize(accepted.run.rootRunId, async () => {
        const current = this.#require(runId)
        if (current.run.generation !== accepted.run.generation || current.cancelRequestedAt)
          throw new DOMException('Execution has been cancelled', 'AbortError')
        const unseen = this.#validateReceipts(runId, receipts).filter(receipt => !this.#options.mailbox.find(receipt.messageId)?.receipt)
        if (unseen.length)
          await this.#options.events.appendBatch(unseen.map(payload => ({ runId, type: 'execution.mailbox.accepted', payload })))
      }),
      waitForChange: input => this.#wait(accepted.run.rootRunId, input.afterRevision, input.signal),
      prepareClose: input => this.#prepareClose(runId, input.outcome, input.consumedReceipts),
    }
  }

  notifyQueuedInput(runId: string): void {
    const current = this.#options.executions.find(runId)
    if (current && !this.#stopped)
      this.#changed(current.run.rootRunId)
  }

  assertShellExecutionAllowed(runId: string): void {
    this.#options.availability?.assertRunExecutable(runId)
    if (this.#options.hostShellSupervision !== false)
      return
    const current = this.#require(runId)
    this.#options.executions.assertCurrent(this.#fence(current))
    if (current.run.parentRunId !== null || this.#options.executions.listTree(current.run.rootRunId).length > 1)
      throw new ShellSupervisionUnavailableError()
    this.#uncontainedShellRoots.add(current.run.rootRunId)
  }

  async admitChild(input: AdmitChildExecutionInput): Promise<ExecutionStateRecord> {
    await this.#options.mutations.waitForRun(input.callerId)
    const rootRunId = this.#require(input.callerId).run.rootRunId
    return this.#serialize(rootRunId, async () => {
      if (this.#stopped)
        throw new ExecutionAdmissionError('stale')
      if (this.#uncontainedShellRoots.has(rootRunId))
        throw new ShellSupervisionUnavailableError()
      const currentEffects = this.#options.mutations.getRunState(input.callerId)
      if (currentEffects.active || currentEffects.pending)
        throw new ExecutionAdmissionError('busy')
      this.#options.availability?.assertRunExecutable(input.callerId)
      const accepted = this.#options.executions.admitChild(input)
      if (accepted.created) {
        this.#changed(rootRunId)
        const id = accepted.execution.run.id
        const completion = Promise.resolve().then(async () => {
          const handle = await this.#options.launchChild(id)
          return handle.completion
        }).catch(error => this.failBeforeStart(id, error))
        this.#children.set(id, completion)
        void completion.finally(() => {
          this.#children.delete(id)
          this.#changed(rootRunId)
        }).catch(() => {})
      }
      return accepted.execution
    })
  }

  send(sourceRunId: string, message: ExecutionMailboxDraft): Promise<void> {
    const source = this.#require(sourceRunId)
    return this.#serialize(source.run.rootRunId, async () => {
      const current = this.#require(sourceRunId)
      const target = this.#require(message.targetRunId)
      const previous = this.#options.mailbox.find(message.messageId)
      if (previous) {
        const expected = previous.message
        if (expected.sourceRunId !== sourceRunId || expected.targetRunId !== message.targetRunId || expected.targetGeneration !== message.targetGeneration
          || expected.kind !== message.kind || expected.text !== message.text
          || ('questionId' in expected ? expected.questionId : null) !== ('questionId' in message ? message.questionId : null)
          || ('audience' in expected ? expected.audience : null) !== ('audience' in message ? message.audience : null)
          || ('origin' in expected ? expected.origin : null) !== ('origin' in message ? message.origin : null)
          || ('purpose' in expected ? expected.purpose : null) !== ('purpose' in message ? message.purpose : null)) {
          throw new ExecutionAdmissionError('conflict')
        }
        return
      }
      this.#options.executions.assertCurrent(this.#fence(current))
      this.#options.executions.assertCurrent(this.#fence(target))
      if (current.run.rootRunId !== target.run.rootRunId || current.phase === 'closed' || current.phase === 'closing' || current.cancelRequestedAt
        || target.phase === 'closed' || target.phase === 'closing' || target.cancelRequestedAt
        || target.run.generation !== message.targetGeneration) {
        throw new ExecutionAdmissionError('stale')
      }
      await this.#options.events.append({ runId: sourceRunId, type: 'execution.mailbox.sent', payload: message })
    })
  }

  answerQuestion(sourceRunId: string | null, questionId: string, text: string, messageId?: string): Promise<void> {
    const question = this.#options.mailbox.findQuestion(questionId)
    if (!question || question.message.kind !== 'question')
      return Promise.reject(new ExecutionAdmissionError('stale'))
    const target = this.#require(question.message.sourceRunId)
    return this.#serialize(target.run.rootRunId, async () => {
      const current = this.#options.mailbox.findQuestion(questionId)
      if (!current || current.message.kind !== 'question'
        || (sourceRunId === null ? current.message.audience !== 'user' : current.message.audience === 'user' || current.message.targetRunId !== sourceRunId)) {
        throw new ExecutionAdmissionError('unauthorized')
      }
      if (current.answer) {
        if (current.answer.text !== text || (messageId && current.answer.messageId !== messageId))
          throw new ExecutionAdmissionError('conflict')
        return
      }
      if (!current.open)
        throw new ExecutionAdmissionError('stale')
      const receiver = this.#require(target.run.id)
      this.#options.executions.assertCurrent(this.#fence(receiver))
      await this.#options.events.append({ runId: sourceRunId ?? receiver.run.id, type: 'execution.mailbox.sent', payload: {
        messageId: messageId ?? `answer:${questionId}`,
        questionId,
        kind: 'answer',
        targetRunId: receiver.run.id,
        targetGeneration: receiver.run.generation,
        text,
      } })
    })
  }

  async wait(runId: string, targetRunIds: readonly string[], timeoutMs: number, signal: AbortSignal, deliveredMessageIds: readonly string[] = []): Promise<'changed' | 'timedout'> {
    const deadline = AbortSignal.timeout(timeoutMs)
    const waitingSignal = AbortSignal.any([signal, deadline])
    try {
      await this.#options.mutations.waitForRun(runId, waitingSignal)
      for (;;) {
        signal.throwIfAborted()
        const caller = this.#require(runId)
        this.#options.executions.assertCurrent(this.#fence(caller))
        const revision = this.#revision(caller.run.rootRunId)
        const pending = this.#options.mailbox.listUnconsumed(runId).some(message =>
          !deliveredMessageIds.includes(message.messageId)
          && !isExecutionProgress(message)
          && (!targetRunIds.length || message.kind !== 'result' || targetRunIds.includes(message.sourceRunId)),
        )
        if (pending || this.#inputs.get(runId)?.hasPendingSteering() || targetRunIds.some(id => this.#require(id).phase === 'closed'))
          return 'changed'
        if (deadline.aborted)
          return 'timedout'
        if (caller.phase === 'working') {
          this.#options.executions.markWaiting(this.#fence(caller))
          this.#changed(caller.run.rootRunId)
        }
        await this.#wait(caller.run.rootRunId, revision, waitingSignal)
      }
    }
    catch (error) {
      if (!deadline.aborted || signal.aborted)
        throw error
      return 'timedout'
    }
    finally {
      if (!signal.aborted)
        await this.#claimWorking(runId, signal)
    }
  }

  async cancel(runId: string, errorCode: string, stop: (runId: string) => Promise<boolean>): Promise<boolean> {
    const source = this.#options.executions.find(runId)
    if (!source || source.phase === 'closed')
      return false
    try {
      this.#options.availability?.assertRunExecutable(runId)
    }
    catch (error) {
      if (!(error instanceof RunEventCorruptionError)) {
        if (!(error instanceof RunEventLogUnavailableError))
          throw error
        const records = this.#options.executions.listTree(source.run.rootRunId)
        for (const record of records)
          this.#preparations.get(record.run.id)?.controller.abort(error)
        const stopped = await Promise.allSettled(records.map(record => stop(record.run.id)))
        const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        throw new AggregateError([error, ...failures], 'Execution cleanup could not settle an unavailable tree')
      }
    }
    const affected = await this.#serialize(source.run.rootRunId, async () => {
      const records = this.#options.executions.requestCancel(runId, new Date().toISOString())
      for (const record of records)
        this.#preparations.get(record.run.id)?.controller.abort()
      this.#changed(source.run.rootRunId)
      return records.filter(record => record.phase !== 'closed')
    })
    const stopped = await Promise.allSettled(affected.map(async (record) => {
      const preparation = this.#preparations.get(record.run.id)
      const owned = await stop(record.run.id)
      if (preparation)
        await preparation.settled
      if (!owned)
        await this.#children.get(record.run.id)
    }))
    const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length)
      throw new AggregateError(failures, 'Execution cleanup could not stop all owners')
    for (const record of affected.toReversed()) {
      if (await this.#recoverQuarantined(record.run.id))
        continue
      const current = this.#require(record.run.id)
      if (current.phase !== 'closed' && !this.#children.has(record.run.id))
        await this.finalize({ runId: record.run.id, cleanup: current.cleanupState === 'degraded' ? 'degraded' : 'completed', outcome: { status: 'cancelled', errorCode } })
    }
    return true
  }

  async failBeforeStart(runId: string, error: unknown): Promise<RunRecord> {
    if (error instanceof RunEventLogUnavailableError && (!(error instanceof RunEventCorruptionError) || error.runId !== runId))
      throw error
    const current = this.#options.executions.find(runId)
    if (!current)
      throw new ExecutionAdmissionError('stale')
    if (current.phase === 'closed')
      return current.run
    const cancelled = current.cancelRequestedAt || (error instanceof Error && error.name === 'AbortError')
    return this.finalize({
      runId,
      cleanup: 'completed',
      outcome: cancelled ? { status: 'cancelled', errorCode: 'RUN_CANCELLED' } : { status: 'failed', errorCode: readStableRunErrorCode(error) },
    })
  }

  async finalize(input: Parameters<ExecutionLifecyclePort['finalize']>[0]): Promise<RunRecord> {
    try {
      return await this.#finalize(input)
    }
    catch (error) {
      if (!(error instanceof RunEventCorruptionError) || error.runId !== input.runId)
        throw error
      return this.#finalizeQuarantined(input.runId, error)
    }
  }

  async #finalizeQuarantined(runId: string, error: RunEventCorruptionError): Promise<RunRecord> {
    const source = this.#options.executions.find(runId)
    if (!source || !this.#options.recoverQuarantinedRun)
      throw error
    if (source.phase === 'closed')
      return source.run
    const affected = this.#options.executions.requestCancel(runId, new Date().toISOString())
    for (const record of affected)
      this.#preparations.get(record.run.id)?.controller.abort(error)
    const children = affected.filter(record => record.run.parentRunId === runId && record.phase !== 'closed')
    await Promise.all(children.map(child => this.cancel(child.run.id, 'RUN_CANCELLED', id => this.#options.stopExecution(id))))
    const result = await this.#recoverQuarantined(runId)
    if (!result)
      throw error
    return result
  }

  async #recoverQuarantined(runId: string): Promise<RunRecord | null> {
    try {
      this.#options.availability?.assertRunExecutable(runId)
      return null
    }
    catch (error) {
      if (!(error instanceof RunEventCorruptionError) || error.runId !== runId || !this.#options.recoverQuarantinedRun)
        throw error
      await this.#options.mutations.waitForRun(runId)
      this.#options.recoverQuarantinedRun(runId)
      const current = this.#options.executions.find(runId)
      if (!current || current.phase !== 'closed')
        throw error
      this.#changed(current.run.rootRunId)
      if (current.run.parentRunId === null)
        this.#uncontainedShellRoots.delete(current.run.rootRunId)
      return current.run
    }
  }

  async #finalize(input: Parameters<ExecutionLifecyclePort['finalize']>[0]): Promise<RunRecord> {
    const initial = this.#require(input.runId)
    if (initial.phase === 'closed')
      return initial.run
    if (initial.phase !== 'closing')
      await this.#prepareClose(input.runId, input.outcome, [])
    const effects = await this.#options.mutations.waitForRun(input.runId)
    return this.#serialize(initial.run.rootRunId, async () => {
      const current = this.#require(input.runId)
      if (current.phase === 'closed')
        return current.run
      if (current.phase !== 'closing')
        throw new ExecutionAdmissionError('pending')
      if (input.outcome.closingGeneration !== undefined && input.outcome.closingGeneration !== current.run.generation && !current.cancelRequestedAt)
        throw new ExecutionAdmissionError('stale')
      const degraded = input.cleanup === 'degraded' || effects.hazards.length > 0
        || (current.run.parentRunId === null && this.#options.executions.listTree(current.run.rootRunId).some(child => child.cleanupState === 'degraded'))
      this.#options.executions.recordCleanup(input.runId, degraded ? 'degraded' : 'clean', degraded ? 'EXECUTION_CLEANUP_DEGRADED' : null)
      const outcome: RunExecutionOutcome = current.cancelRequestedAt
        ? { status: 'cancelled', errorCode: input.outcome.status === 'cancelled' ? input.outcome.errorCode : 'RUN_CANCELLED' }
        : input.outcome
      const errorCode = outcome.status === 'completed' ? null : outcome.status === 'cancelled' ? outcome.errorCode ?? 'RUN_CANCELLED' : outcome.errorCode
      const body = await this.#options.readResult(input.runId)
      const resultText = [outcome.status === 'completed' ? '' : `${outcome.status}: ${errorCode ?? 'RUN_CANCELLED'}`, degraded ? 'EXECUTION_CLEANUP_DEGRADED' : '', body].filter(Boolean).join('\n') || outcome.status
      const precedingEvents = current.run.parentRunId && current.resultMailboxId
        ? [{ runId: input.runId, type: 'execution.mailbox.sent', payload: {
            messageId: current.resultMailboxId,
            targetRunId: current.run.parentRunId,
            targetGeneration: current.admittedParentGeneration,
            kind: 'result' as const,
            text: previewExecutionResult(resultText, input.runId),
          } }]
        : []
      const result = await this.#options.lifecycle.finalize({
        runId: input.runId,
        status: outcome.status,
        errorCode,
        ...(outcome.status === 'failed' && outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        completedAt: new Date().toISOString(),
        precedingEvents,
      })
      this.#changed(current.run.rootRunId)
      if (current.run.parentRunId === null)
        this.#uncontainedShellRoots.delete(current.run.rootRunId)
      return result
    })
  }

  async #prepareClose(runId: string, outcome: RunExecutionOutcome, consumed: readonly ExecutionMailboxReceipt[]) {
    await this.#options.mutations.waitForRun(runId)
    const current = this.#require(runId)
    const prepared = await this.#serialize(current.run.rootRunId, async () => {
      let record = this.#require(runId)
      const stopChildren = record.cancelRequestedAt !== null || outcome.status !== 'completed'
      if (record.phase === 'closing')
        return { result: { kind: 'sealed' as const, closingGeneration: record.run.generation }, stopChildren }
      if (record.phase === 'closed')
        throw new ExecutionAdmissionError('stale')
      if (consumed.length && !record.cancelRequestedAt) {
        const receipts = this.#validateReceipts(runId, consumed).filter(receipt => this.#options.mailbox.find(receipt.messageId)?.state !== 'consumed')
        if (receipts.length)
          await this.#options.events.appendBatch(receipts.map(payload => ({ runId, type: 'execution.mailbox.consumed', payload })))
      }
      record = this.#require(runId)
      const mode = record.cancelRequestedAt || outcome.status === 'cancelled' ? 'cancel' : outcome.status === 'failed' ? 'failure' : 'success'
      try {
        if (mode === 'success' && this.#inputs.get(runId)?.hasPendingInput())
          throw new ExecutionAdmissionError('pending')
        const root = this.#options.executions.find(record.run.rootRunId)
        if (!root)
          throw new ExecutionAdmissionError('stale')
        const closing = this.#options.executions.beginClosing(executionFence(record, root), mode)
        this.#changed(record.run.rootRunId)
        return { result: { kind: 'sealed' as const, closingGeneration: closing.run.generation }, stopChildren }
      }
      catch (error) {
        if (!(error instanceof ExecutionAdmissionError) || error.code !== 'pending')
          throw error
        if (record.phase === 'working') {
          this.#options.executions.markWaiting(this.#fence(record))
          this.#changed(record.run.rootRunId)
        }
        return { result: { kind: 'pending' as const, revision: this.#revision(record.run.rootRunId) }, stopChildren: false }
      }
    })
    if (prepared.stopChildren) {
      const children = this.#options.executions.listTree(current.run.rootRunId).filter(child => child.run.parentRunId === runId && child.phase !== 'closed')
      await Promise.all(children.map(child => this.cancel(child.run.id, 'RUN_CANCELLED', id => this.#options.stopExecution(id))))
      await Promise.all(children.flatMap(child => this.#children.has(child.run.id) ? [this.#children.get(child.run.id)!] : []))
    }
    return prepared.result
  }

  #validateReceipts(runId: string, receipts: readonly ExecutionMailboxReceipt[]): ExecutionMailboxReceipt[] {
    return receipts.map((receipt) => {
      const record = this.#options.mailbox.find(receipt.messageId)
      if (!record || record.message.targetRunId !== runId || record.message.sourceRunId !== receipt.sourceRunId
        || record.message.payloadHash !== receipt.payloadHash || (record.receipt && record.receipt.contextEntryId !== receipt.contextEntryId)) {
        throw new ExecutionAdmissionError('conflict')
      }
      return receipt
    })
  }

  async #claimWorking(runId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const record = this.#require(runId)
      const revision = this.#revision(record.run.rootRunId)
      if (record.phase === 'working') {
        this.#options.executions.assertCurrent(this.#fence(record))
        return
      }
      try {
        this.#options.executions.claimWorking(this.#fence(record))
        this.#changed(record.run.rootRunId)
        return
      }
      catch (error) {
        if (!(error instanceof ExecutionAdmissionError) || error.code !== 'busy')
          throw error
        await this.#wait(record.run.rootRunId, revision, signal)
      }
    }
  }

  #wait(rootRunId: string, afterRevision: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.#stopped)
      return Promise.reject(new DOMException('Execution runtime is stopping', 'AbortError'))
    return new Promise((resolve, reject) => {
      let subscription: { dispose: () => void } | undefined
      const abort = () => {
        subscription?.dispose()
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new DOMException('Execution cancelled', 'AbortError'))
      }
      const finish = () => {
        subscription?.dispose()
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      subscription = this.#changes.event((event) => {
        if (event.rootRunId === rootRunId)
          finish()
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (this.#revision(rootRunId) !== afterRevision)
        finish()
    })
  }

  #require(runId: string): ExecutionStateRecord {
    this.#options.availability?.assertRunExecutable(runId)
    const record = this.#options.executions.find(runId)
    if (!record)
      throw new ExecutionAdmissionError('stale')
    return record
  }

  #fence(record: ExecutionStateRecord) {
    return executionFence(record, this.#require(record.run.rootRunId))
  }

  #revision(rootRunId: string): number {
    return this.#revisions.get(rootRunId) ?? 0
  }

  #changed(rootRunId: string): void {
    this.#revisions.set(rootRunId, this.#revision(rootRunId) + 1)
    this.#changes.fire({ rootRunId })
  }

  #serialize<T>(rootRunId: string, operation: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(rootRunId) ?? Promise.resolve()
    const pending = before.catch(() => {}).then(operation)
    this.#tails.set(rootRunId, pending)
    void pending.finally(() => {
      if (this.#tails.get(rootRunId) === pending)
        this.#tails.delete(rootRunId)
    }).catch(() => {})
    return pending
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    try {
      await this.cancelAll({}, id => this.#options.stopExecution(id))
    }
    finally {
      for (const preparation of this.#preparations.values())
        preparation.controller.abort()
      for (const rootRunId of this.#revisions.keys())
        this.#changed(rootRunId)
      await Promise.allSettled([...this.#children.values(), ...this.#tails.values()])
      this.#subscription.dispose()
      this.#changes.dispose()
    }
  }

  async cancelAll(filter: { conversationId?: string, runIds?: readonly string[] }, stop: (runId: string) => Promise<boolean>): Promise<number> {
    const requested = filter.runIds ? new Set(filter.runIds.map(id => this.#options.executions.find(id)?.run.rootRunId).filter((id): id is string => Boolean(id))) : null
    const pending = this.#options.listIncomplete()
    const roots = new Set(pending.filter(run => (!filter.conversationId || run.conversationId === filter.conversationId) && (!requested || requested.has(run.rootRunId))).map(run => run.rootRunId))
    const settled = await Promise.allSettled([...roots].map(id => this.cancel(id, 'RUN_CANCELLED', stop)))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length)
      throw new AggregateError(failures, 'Execution cleanup could not settle every root')
    return roots.size
  }
}
