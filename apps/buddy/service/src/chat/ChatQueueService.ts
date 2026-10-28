import type { LocalChatQueueReceipt, LocalChatQueueScope, LocalChatQueueSteerResult, LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { LocalRun } from '../../../shared/runs/runApi'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { BuddyStartTurnInput } from '../BuddyRuntime'
import type { RunEventAvailability, RunEventObservation } from '../events/RunEventPorts'
import type { ChatQueueRepository, QueuedTurnRequestInput } from '../storage/chatQueueRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { PrepareTurnRequestInput, TurnRequestRepository } from '../storage/turnRequestRepository'
import type { ChatTurnService } from './ChatTurnService'
import { createHash, randomUUID } from 'node:crypto'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { createBuddyInputReference } from '../agent/context/BuddyInputReference'
import { getAttachmentLabels } from '../attachments/attachmentLabels'
import { buddyExecutionFingerprint } from '../buddies/BuddyExecutionDefinition'
import { RunEventCorruptionError } from '../events/RunEventFailure'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export interface ChatQueueServiceOptions {
  availability?: Pick<RunEventAvailability, 'assertConversationWritable' | 'assertRunExecutable'>
  getRunPermissionCeiling: (runId: string) => BuddyExecutionProfile | undefined
  queue: ChatQueueRepository
  turns: Pick<ChatTurnService, 'cancel' | 'prepareStart' | 'refreshQueuedInput' | 'validatePreparedInput'>
  requests: Pick<TurnRequestRepository, 'prepare'>
  launcher: Pick<BuddyTurnLauncher, 'launch'>
  runner: Pick<BuddyAgentRunner, 'steer' | 'followUp' | 'hasActiveExecution' | 'hasDegradedCleanup' | 'isStopping'>
  eventLog: Pick<RunEventObservation, 'state'>
  onObserverError?: (error: unknown) => void
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'findById'>
}

export type ChatQueueChange = EventSnapshot<{
  kind: 'enqueued' | 'cancelled' | 'delivered' | 'dispatched' | 'paused'
  scope: LocalChatQueueScope
  committed?: { commitId: string, requestId: string, queueId: string, runId?: string, messageId?: string, draftReceipt?: LocalChatQueueReceipt['draftReceipt'], attachmentOwnership?: { kind: 'queue' | 'message', attachmentIds: readonly string[] } }
}>

export class ChatQueueService {
  readonly #options: ChatQueueServiceOptions
  readonly #operations = new Map<string, Promise<void>>()
  readonly #enqueues = new Set<Promise<unknown>>()
  readonly #cancellations = new Map<string, { conversationId: string, buddyId: string, completion: Promise<LocalRun> }>()
  readonly #changes: Emitter<ChatQueueChange>
  readonly #stopping = new AbortController()
  readonly onDidChange: Emitter<ChatQueueChange>['event']
  #disposed = false

  constructor(options: ChatQueueServiceOptions) {
    this.#options = options
    this.#changes = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#changes.event
    options.queue.pause()
  }

  dispose() {
    this.#disposed = true
    this.#stopping.abort()
    this.#options.queue.pause()
    this.#changes.dispose()
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#operations.values(), ...this.#enqueues, ...[...this.#cancellations.values()].map(cancellation => cancellation.completion)])
  }

  continuationScopes(): LocalChatQueueScope[] {
    return this.#options.queue.continuationScopes()
  }

  pause(scope: LocalChatQueueScope, actorId?: string): void {
    if (this.#disposed)
      return
    if (actorId ? this.#options.queue.pauseActor(scope, actorId) : this.#options.queue.pause(scope.conversationId))
      this.#changed('paused', scope)
  }

  list(scope: LocalChatQueueScope) {
    return this.#options.queue.list(scope)
  }

  cancelRun(runId: string): Promise<LocalRun> {
    const pending = this.#cancellations.get(runId)
    if (pending)
      return pending.completion
    const run = this.#options.runs.findById(runId)
    if (!run)
      return this.#options.turns.cancel(runId)
    const active = this.#options.queue.activeRun(run, run.buddyId)
    if (active ? active.id !== runId : this.#options.queue.latestRun(run, run.buddyId)?.id !== runId || !this.#options.runner.hasActiveExecution(run.conversationId))
      return this.#options.turns.cancel(runId)
    const cancellation = Promise.withResolvers<LocalRun>()
    this.#cancellations.set(runId, { conversationId: run.conversationId, buddyId: run.buddyId, completion: cancellation.promise })
    void this.#cancelRun(run).then(cancellation.resolve, cancellation.reject)
    return cancellation.promise
  }

  async #cancelRun(run: RunRecord): Promise<LocalRun> {
    try {
      this.pause(run, run.buddyId)
      return await this.#options.turns.cancel(run.id)
    }
    finally {
      try {
        this.pause(run, run.buddyId)
      }
      finally {
        this.#cancellations.delete(run.id)
      }
    }
  }

  enqueue(input: BuddyStartTurnInput): Promise<LocalChatQueueReceipt> {
    const pending = Promise.withResolvers<LocalChatQueueReceipt>()
    this.#enqueues.add(pending.promise)
    void this.#enqueue({ ...input }).then((value) => {
      this.#enqueues.delete(pending.promise)
      pending.resolve(value)
    }, (error) => {
      this.#enqueues.delete(pending.promise)
      pending.reject(error)
    })
    return pending.promise
  }

  async #enqueue(input: BuddyStartTurnInput) {
    if (this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const fingerprint = createHash('sha256').update(JSON.stringify([input.draftId, input.expectedRevision, ...(input.delivery ? [input.delivery] : [])])).digest('hex')
    const replay = this.#options.queue.replay(input.requestId, fingerprint)
    if (replay)
      return replay
    const { prepared, stagedAttachments } = await this.#options.turns.prepareStart(input)
    let result
    try {
      if (this.#disposed)
        throw new BuddyServiceError('VALIDATION_FAILED')
      const concurrent = this.#options.queue.replay(input.requestId, fingerprint)
      if (concurrent) {
        await stagedAttachments.rollback()
        return concurrent
      }
      this.#options.availability?.assertConversationWritable(prepared.conversationId)
      stagedAttachments.validate()
      const target = this.#options.queue.validateDelivery(prepared)
      if (prepared.delivery?.mode === 'current' && target) {
        if (!this.#canFollowUp(target.run, prepared))
          throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
        await this.#options.turns.validatePreparedInput(prepared, false)
        const current = this.#options.queue.validateDelivery(prepared)!
        if (!this.#canFollowUp(current.run, prepared))
          throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
      }
      result = this.#options.queue.enqueue({ ...prepared, requestFingerprint: fingerprint })
    }
    catch (error) {
      await stagedAttachments.rollback()
      throw error
    }
    const latest = this.#options.queue.latestRun(result, prepared.buddyId)
    if (this.#isCancelling(result, prepared.buddyId) || latest?.status === 'cancelled' || latest?.status === 'failed')
      this.pause(result, prepared.buddyId)
    this.#changed('enqueued', result, { commitId: randomUUID(), requestId: input.requestId, queueId: result.id, draftReceipt: result.draftReceipt, ...(prepared.attachmentBindings.length ? { attachmentOwnership: { kind: 'queue', attachmentIds: prepared.attachmentBindings.map(binding => binding.id) } } : {}) })
    await stagedAttachments.commit().catch(() => undefined)
    if (prepared.delivery?.mode === 'current' && prepared.delivery.target) {
      void this.steer(result).then((status) => {
        if (status !== 'accepted')
          this.#pauseItem(result)
      }).catch(() => this.#pauseItem(result))
    }
    else if (!prepared.delivery && prepared.actorIds?.length === 1 && this.#options.queue.activeRun(result, prepared.buddyId)
      && this.#options.queue.list(result).find(item => item.buddyId === prepared.buddyId)?.id === result.id) {
      void this.steer(result).catch(() => this.pause(result, prepared.buddyId))
    }
    return result
  }

  cancel(target: LocalChatQueueTarget) {
    if (this.#disposed)
      return false
    const cancelled = this.#options.queue.cancel(target)
    if (cancelled)
      this.#changed('cancelled', target)
    return cancelled
  }

  steer(target: LocalChatQueueTarget): Promise<LocalChatQueueSteerResult> {
    const active = this.#options.queue.activeRun(target, this.#options.queue.pending(target)?.buddyId)
    return this.#serialize(target, async () => {
      if (this.#isCancelling(target, this.#options.queue.pending(target)?.buddyId))
        return 'unavailable'
      const queued = this.#options.queue.pending(target)
      if (queued?.delivery) {
        if (queued.delivery.mode === 'next' && queued.delivery.target) {
          const execution = this.#options.queue.validateDelivery(queued)
          if (execution && execution.phase !== 'closed')
            return this.#steerCurrent(target, queued, true)
        }
        if (queued.delivery.mode === 'next' || !queued.delivery.target)
          return await this.#dispatch(target, true) ? 'accepted' : 'unavailable'
        return this.#steerCurrent(target, queued)
      }
      if (!active) {
        if (this.#options.queue.pending(target)?.queueRouting?.mode !== 'actor' && this.#options.queue.activeRun(target))
          return 'incompatible'
        return await this.#dispatch(target, true) ? 'accepted' : 'unavailable'
      }
      const pending = this.#options.queue.pending(target)
      if (!pending || this.#options.queue.activeRun(target, pending?.buddyId)?.id !== active.id)
        return 'unavailable'
      const input = await this.#options.turns.refreshQueuedInput(pending)
      const run = this.#options.runs.findById(active.id)
      if (!run)
        return 'unavailable'
      if (!this.#canFollowUp(run, input))
        return 'incompatible'
      await this.#options.turns.validatePreparedInput(input, false)
      if (this.#disposed || this.#isCancelling(target, this.#options.queue.pending(target)?.buddyId) || this.#options.eventLog.state !== 'open' || !this.#options.queue.pending(target) || !this.#options.queue.isCurrentInput(input) || this.#options.queue.activeRun(target, pending?.buddyId)?.id !== active.id)
        return 'unavailable'
      const current = this.#options.runs.findById(active.id)
      if (!current || !this.#canFollowUp(current, input))
        return 'incompatible'
      return this.#deliver(input, active.id, 'steer') ? 'accepted' : 'unavailable'
    }, 'unavailable')
  }

  async followUp(runId: string, signal: AbortSignal) {
    const run = this.#options.runs.findById(runId)
    if (!run || run.purpose !== 'chat')
      return false
    try {
      return await this.#serialize(run, async () => {
        if (signal.aborted || this.#isCancelling(run, run.buddyId) || this.#options.queue.activeRun(run, run.buddyId)?.id !== runId)
          return false
        const next = this.#options.queue.list(run).find(item => item.buddyId === run.buddyId)
        if (next?.state !== 'waiting' || (next.delivery && (next.delivery.mode !== 'current' || next.delivery.target?.runId !== runId)))
          return false
        const pending = this.#options.queue.pending(next)
        if (!pending)
          return false
        const input = await this.#options.turns.refreshQueuedInput(pending)
        const refreshedRun = this.#options.runs.findById(runId)
        if (!refreshedRun || !this.#canFollowUp(refreshedRun, input))
          return false
        await this.#options.turns.validatePreparedInput(input)
        if (this.#disposed || this.#isCancelling(run, run.buddyId) || this.#options.eventLog.state !== 'open' || signal.aborted)
          return false
        const head = this.#options.queue.list(run).find(item => item.buddyId === run.buddyId)
        if (this.#options.queue.activeRun(run, run.buddyId)?.id !== runId
          || head?.id !== next.id || head.state !== 'waiting'
          || !this.#options.queue.pending(next) || !this.#options.queue.isCurrentInput(input)) {
          return false
        }
        const current = this.#options.runs.findById(runId)
        if (!current || !this.#canFollowUp(current, input))
          return false
        return this.#deliver(input, runId, 'followUp')
      }, false)
    }
    catch {
      if (!this.#disposed)
        this.pause(run, run.buddyId)
      return false
    }
  }

  async #steerCurrent(target: LocalChatQueueTarget, pending: QueuedTurnRequestInput, promoteNext = false): Promise<LocalChatQueueSteerResult> {
    try {
      const source: QueuedTurnRequestInput = promoteNext ? { ...pending, delivery: { ...pending.delivery!, mode: 'current' } } : pending
      this.#options.queue.validateDelivery(source)
      const input = await this.#options.turns.refreshQueuedInput(source)
      const execution = this.#options.queue.validateDelivery(input)!
      if (!this.#canFollowUp(execution.run, input))
        throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
      await this.#options.turns.validatePreparedInput(input, false)
      const current = this.#options.queue.validateDelivery(input)!
      if (!this.#canFollowUp(current.run, input))
        throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
      if (this.#disposed || this.#options.eventLog.state !== 'open' || this.#isCancelling(target, input.buddyId)
        || !this.#options.queue.pending(target) || !this.#options.queue.isCurrentInput(input)) {
        throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
      }
      if (!this.#deliver(input, execution.run.id, 'steer', promoteNext))
        throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
      return 'accepted'
    }
    catch (error) {
      if (promoteNext) {
        if (error instanceof BuddyServiceError && error.code === 'INPUT_DELIVERY_INCOMPATIBLE')
          return 'incompatible'
        if (error instanceof BuddyServiceError && error.code === 'INPUT_DELIVERY_TARGET_UNAVAILABLE')
          return 'unavailable'
        throw error
      }
      this.#pauseItem(target)
      throw error
    }
  }

  #pauseItem(target: LocalChatQueueTarget) {
    if (!this.#disposed && this.#options.queue.pauseItem(target))
      this.#changed('paused', target)
  }

  #canFollowUp(run: RunRecord, input: PrepareTurnRequestInput) {
    if (input.delivery && (input.delivery.mode !== 'current' || input.delivery.target?.runId !== run.id
      || input.delivery.target.rootRunId !== run.rootRunId || input.delivery.actorId !== run.buddyId)) {
      return false
    }
    const current = this.#options.runInputs.findByRunId(run.id)
    if (!current)
      return false
    const liveSelection = run.modelOverride ?? run.actorSnapshot?.model
    const selection = liveSelection ?? { modelId: run.model, providerId: run.provider, reasoning: current.reasoning, serviceTier: current.serviceTier }
    return run.status === 'running' && run.branchId === input.branchId
      && run.buddyId === input.buddyId
      && (run.actorSnapshot && input.actorSnapshot ? buddyExecutionFingerprint(run.actorSnapshot) === buddyExecutionFingerprint(input.actorSnapshot) : !!run.actorSnapshot === !!input.actorSnapshot)
      && selection.modelId === input.model && selection.providerId === input.provider
      && selection.reasoning === input.runInput.reasoning && selection.serviceTier === input.runInput.serviceTier
      && this.#options.getRunPermissionCeiling(run.id) === input.runExecutionProfile
      && (!!liveSelection || (run.contextWindow === (input.modelParameters?.contextWindow ?? null)
        && run.maxTokens === (input.modelParameters?.maxTokens ?? null)))
  }

  #deliver(input: QueuedTurnRequestInput, runId: string, mode: 'steer' | 'followUp', promoteNext = false) {
    this.#options.availability?.assertRunExecutable(runId)
    return this.#options.runner[mode](runId, () => {
      this.#options.availability?.assertRunExecutable(runId)
      const documents = input.attachmentBindings.flatMap(binding => isDocumentMimeType(binding.mimeType)
        ? [{ attachmentId: binding.id, mimeType: binding.mimeType }]
        : [])
      const reference = createBuddyInputReference({
        attachmentIds: [...input.runInput.attachmentIds],
        resourceLabels: getAttachmentLabels(input.attachmentBindings, input.runInput.prompt),
        ...(documents.length ? { documents } : {}),
        messageId: input.userMessageId,
        prompt: input.runInput.prompt,
        images: input.attachmentBindings.flatMap((binding) => {
          const metadata = binding.mimeType
          return metadata?.startsWith('image/') && metadata !== 'image/svg+xml' ? [{ attachmentId: binding.id, mimeType: metadata }] : []
        }),
      })
      this.#options.queue.commitInRun(input, runId, this.#options.getRunPermissionCeiling(runId), promoteNext)
      this.#changed('delivered', input, { commitId: randomUUID(), requestId: input.requestId, queueId: input.queuedMessageId!, runId, messageId: input.userMessageId, ...(input.attachmentBindings.length ? { attachmentOwnership: { kind: 'message', attachmentIds: input.attachmentBindings.map(binding => binding.id) } } : {}) })
      return reference
    }, input.runInput.contextItems.flatMap(item => item.kind === 'skill' && item.skill ? [item.skill] : []))
  }

  reconcile(scope: LocalChatQueueScope) {
    return this.#serialize(scope, async () => {
      const current = this.#options.queue.continuationScope(scope.conversationId)
      if (!current)
        return false
      if (this.#options.runner.hasDegradedCleanup(current.conversationId)) {
        this.pause(current)
        return false
      }
      const visited = new Set<string>()
      let dispatched = false
      for (const next of this.#options.queue.list(current)) {
        if (visited.has(next.buddyId))
          continue
        visited.add(next.buddyId)
        if (next.state !== 'waiting')
          continue
        if (next.delivery?.mode === 'current' && next.delivery.target) {
          try {
            const pending = this.#options.queue.pending(next)
            if (pending)
              this.#options.queue.validateDelivery(pending)
          }
          catch (error) {
            if (!(error instanceof BuddyServiceError))
              throw error
            this.#pauseItem(next)
          }
          continue
        }
        const latest = this.#options.queue.latestRun(current, next.buddyId)
        if (latest?.status === 'failed' || latest?.status === 'cancelled') {
          this.pause(current, next.buddyId)
          continue
        }
        dispatched = await this.#dispatch(next) || dispatched
      }
      return dispatched
    }, false)
  }

  async #dispatch(target: LocalChatQueueTarget, allowPaused = false) {
    const pending = this.#options.queue.pending(target)
    if (!pending || !this.#canDispatch(pending))
      return false
    const input = await this.#options.turns.refreshQueuedInput(pending)
    await this.#options.turns.validatePreparedInput(input)
    if (!this.#canDispatch(input) || !this.#options.queue.pending(target) || !this.#options.queue.isCurrentInput(input))
      return false
    const head = this.#options.queue.list(target).find(item => item.buddyId === input.buddyId)
    if (!allowPaused && (head?.id !== target.id || head.state !== 'waiting'))
      return false
    const prepared = this.#options.requests.prepare({ ...input, createdAt: new Date().toISOString() })
    this.#changed('dispatched', target)
    const turn = await this.#options.launcher.launch(prepared.runId, this.#stopping.signal)
    void turn.completion.catch(() => {})
    return true
  }

  #canDispatch(scope: QueuedTurnRequestInput): boolean {
    try {
      this.#options.availability?.assertConversationWritable(scope.conversationId)
    }
    catch (error) {
      if (!(error instanceof RunEventCorruptionError))
        throw error
      return false
    }
    return !this.#disposed && !this.#isCancelling(scope, scope.buddyId) && !this.#options.runner.isStopping && this.#options.eventLog.state === 'open'
      && this.#options.queue.canDispatchDelivery(scope)
      && !this.#options.queue.activeRun(scope, scope.buddyId)
      && (scope.queueRouting?.mode === 'actor' || !this.#options.queue.activeRun(scope))
      && !this.#options.runner.hasActiveExecution(scope.conversationId, scope.buddyId)
  }

  #isCancelling(scope: LocalChatQueueScope, actorId?: string): boolean {
    return [...this.#cancellations.values()].some(cancellation => cancellation.conversationId === scope.conversationId && (!actorId || cancellation.buddyId === actorId))
  }

  #changed(kind: ChatQueueChange['kind'], scope: LocalChatQueueScope, committed?: ChatQueueChange['committed']): void {
    this.#changes.fire(copyEventSnapshot({ kind, scope: { conversationId: scope.conversationId, branchId: scope.branchId }, ...(committed ? { committed } : {}) }))
  }

  async #serialize<T>(scope: LocalChatQueueScope, operation: () => Promise<T>, disposed: T): Promise<T> {
    const previous = this.#operations.get(scope.conversationId)
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#operations.set(scope.conversationId, promise)
    await previous
    try {
      return this.#disposed ? disposed : await operation()
    }
    finally {
      if (this.#operations.get(scope.conversationId) === promise)
        this.#operations.delete(scope.conversationId)
      resolve()
    }
  }
}
