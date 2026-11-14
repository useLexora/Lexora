import type { LocalChatQueueReceipt, LocalChatQueueScope, LocalChatQueueSteerResult, LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { LocalRun } from '../../../shared/runs/runApi'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { BuddyStartTurnInput } from '../BuddyRuntime'
import type { RunEventAvailability, RunEventObservation } from '../events/RunEventPorts'
import type { ChatControlCommandRepository } from '../storage/ChatControlCommandRepository'
import type { ChatQueueRepository, QueuedTurnRequestInput } from '../storage/chatQueueRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { PrepareTurnRequestInput, TurnRequestRepository } from '../storage/turnRequestRepository'
import type { ChatTurnService, PreparedStartTurnInput } from './ChatTurnService'
import { createHash, randomUUID } from 'node:crypto'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { createBuddyInputReference } from '../agent/context/BuddyInputReference'
import { getAttachmentLabels } from '../attachments/attachmentLabels'
import { buddyExecutionFingerprint } from '../buddies/BuddyExecutionDefinition'
import { RunEventCorruptionError } from '../events/RunEventFailure'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { PreparedResourceSettlement } from './PreparedResourceSettlement'

export interface ChatQueueServiceOptions {
  control?: ChatControlCommandRepository
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
  readonly #cancellations = new Map<string, { conversationId: string, branchId: string, buddyId: string, completion: Promise<LocalRun> }>()
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
    try {
      this.#options.queue.pause()
    }
    finally {
      this.#changes.dispose()
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#operations.values(), ...this.#enqueues, ...[...this.#cancellations.values()].map(cancellation => cancellation.completion)])
  }

  get hasPendingOperations(): boolean {
    return this.#operations.size > 0 || this.#enqueues.size > 0 || this.#cancellations.size > 0
  }

  continuationScopes(): LocalChatQueueScope[] {
    return this.#options.queue.continuationScopes()
  }

  pause(scope: LocalChatQueueScope, actorId?: string): void {
    if (this.#disposed)
      return
    if (actorId ? this.#options.queue.pauseActor(scope, actorId) : this.#options.queue.pause(scope.conversationId, scope.branchId))
      this.#changed('paused', scope)
  }

  list(scope: LocalChatQueueScope) {
    return this.#options.queue.list(scope).map((item) => {
      if (!this.#options.control)
        return item
      const condition = this.#options.control.queueTarget(item)
      const active = this.#options.queue.activeRun(scope, item.buddyId)
      const run = active ? this.#options.runs.findById(active.id) : null
      return { ...item, ...(condition ? { revision: condition.expectedRevision } : {}), steerTarget: run ? { runId: run.id, generation: run.generation } : null }
    })
  }

  cancelRun(runId: string): Promise<LocalRun> {
    const pending = this.#cancellations.get(runId)
    if (pending)
      return pending.completion
    const run = this.#options.runs.findById(runId)
    if (!run)
      return this.#options.turns.cancel(runId)
    const active = this.#options.queue.activeRun(run, run.buddyId)
    if (active ? active.id !== runId : this.#options.queue.latestRun(run, run.buddyId)?.id !== runId || !this.#options.runner.hasActiveExecution(run.conversationId, run.buddyId, run.branchId))
      return this.#options.turns.cancel(runId)
    const cancellation = Promise.withResolvers<LocalRun>()
    this.#cancellations.set(runId, { conversationId: run.conversationId, branchId: run.branchId, buddyId: run.buddyId, completion: cancellation.promise })
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
    const { prepared, stagedAttachments } = await this.prepareEnqueue(input)
    const resources = new PreparedResourceSettlement(stagedAttachments, this.#options.onObserverError)
    let result
    try {
      const concurrent = this.#options.queue.replay(input.requestId, fingerprint)
      if (concurrent) {
        await resources.rollback()
        return concurrent
      }
      stagedAttachments.validate()
      result = this.commitEnqueue(prepared, fingerprint)
    }
    catch (error) {
      await resources.fail(error)
      throw error
    }
    await resources.commit()
    this.publishEnqueued(prepared, result)
    return result
  }

  async prepareEnqueue(input: PreparedStartTurnInput) {
    if (this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const materialized = await this.#options.turns.prepareStart(input)
    try {
      this.#validateEnqueue(materialized.prepared)
      if (materialized.prepared.delivery?.mode === 'current')
        await this.#options.turns.validatePreparedInput(materialized.prepared, false)
      this.#validateEnqueue(materialized.prepared)
      return materialized
    }
    catch (error) {
      await materialized.stagedAttachments.rollback().catch(() => undefined)
      throw error
    }
  }

  commitEnqueue(prepared: PrepareTurnRequestInput, fingerprint: string) {
    this.#validateEnqueue(prepared)
    return this.#options.queue.enqueue({ ...prepared, requestFingerprint: fingerprint })
  }

  #validateEnqueue(prepared: PrepareTurnRequestInput) {
    if (this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#options.availability?.assertConversationWritable(prepared.conversationId)
    const target = this.#options.queue.validateDelivery(prepared)
    if (prepared.delivery?.mode === 'current' && target && !this.#canFollowUp(target.run, prepared))
      throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
  }

  publishEnqueued(prepared: PrepareTurnRequestInput, result: LocalChatQueueReceipt): void {
    const latest = this.#options.queue.latestRun(result, prepared.buddyId)
    if (this.#isCancelling(result, prepared.buddyId) || latest?.status === 'cancelled' || latest?.status === 'failed')
      this.pause(result, prepared.buddyId)
    this.#changed('enqueued', result, { commitId: randomUUID(), requestId: prepared.requestId, queueId: result.id, draftReceipt: result.draftReceipt, ...(prepared.attachmentBindings.length ? { attachmentOwnership: { kind: 'queue', attachmentIds: prepared.attachmentBindings.map(binding => binding.id) } } : {}) })
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
  }

  cancel(target: LocalChatQueueTarget) {
    if (this.#disposed)
      return false
    const cancelled = this.#options.queue.cancel(target)
    if (cancelled)
      this.#changed('cancelled', target)
    return cancelled
  }

  async prepareSteer(target: LocalChatQueueTarget, runId: string) {
    const pending = this.#options.queue.pending(target)
    const run = this.#options.runs.findById(runId)
    if (this.#disposed || !pending || !run || this.#isCancelling(target, pending.buddyId)
      || this.#options.queue.activeRun(target, pending.buddyId)?.id !== runId) {
      throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    }
    const promoteNext = pending.delivery?.mode === 'next'
    const source = promoteNext ? { ...pending, delivery: { ...pending.delivery!, mode: 'current' as const } } : pending
    const input = await this.#options.turns.refreshQueuedInput(source)
    if (!this.#canFollowUp(run, input))
      throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
    await this.#options.turns.validatePreparedInput(input, false)
    return { input, runId, promoteNext }
  }

  commitSteer(prepared: Awaited<ReturnType<ChatQueueService['prepareSteer']>>) {
    const { input, runId, promoteNext } = prepared
    const current = this.#options.runs.findById(runId)
    if (this.#disposed || this.#options.eventLog.state !== 'open' || this.#isCancelling(input, input.buddyId)
      || !current || !this.#canFollowUp(current, input) || !this.#options.queue.isCurrentInput(input)
      || !this.#options.runner.hasActiveExecution(input.conversationId, input.buddyId, input.branchId)) {
      throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    }
    this.#options.availability?.assertRunExecutable(runId)
    const reference = this.#inputReference(input)
    this.#options.queue.commitInRun(input, runId, this.#options.getRunPermissionCeiling(runId), promoteNext)
    return () => {
      this.#changed('delivered', input, { commitId: randomUUID(), requestId: input.requestId, queueId: input.queuedMessageId!, runId, messageId: input.userMessageId })
      return this.#options.runner.steer(runId, () => reference, input.runInput.contextItems.flatMap(item => item.kind === 'skill' && item.skill ? [item.skill] : []))
    }
  }

  async prepareContinue(target: LocalChatQueueTarget) {
    const pending = this.#options.queue.pending(target)
    if (!pending || !this.#canDispatch(pending))
      throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    const latest = this.#options.queue.latestRun(pending, pending.buddyId)
    const input = await this.#options.turns.refreshQueuedInput(pending)
    await this.#options.turns.validatePreparedInput(input)
    return { input, sourceRunId: latest?.id ?? null, sourceGeneration: latest ? this.#options.runs.findById(latest.id)?.generation ?? null : null }
  }

  commitContinue(prepared: Awaited<ReturnType<ChatQueueService['prepareContinue']>>) {
    const { input } = prepared
    const latest = this.#options.queue.latestRun(input, input.buddyId)
    if (!this.#canDispatch(input) || !this.#options.queue.isCurrentInput(input)
      || (latest?.id ?? null) !== prepared.sourceRunId || (latest ? this.#options.runs.findById(latest.id)?.generation ?? null : null) !== prepared.sourceGeneration) {
      throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    }
    const request = this.#options.requests.prepare({ ...input, createdAt: new Date().toISOString() })
    return { request, notify: async () => {
      this.#changed('dispatched', input)
      const turn = await this.#options.launcher.launch(request.runId, this.#stopping.signal)
      void turn.completion.catch(() => {})
    } }
  }

  publishCancelled(target: LocalChatQueueTarget): void {
    this.#changed('cancelled', target)
  }

  steer(target: LocalChatQueueTarget): Promise<LocalChatQueueSteerResult> {
    const condition = this.#options.control?.queueTarget(target)
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
      return this.#deliver(input, active.id, 'steer', false, condition) ? 'accepted' : 'unavailable'
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
        const condition = this.#options.control?.queueTarget(next)
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
        return this.#deliver(input, runId, 'followUp', false, condition)
      }, false)
    }
    catch {
      if (!this.#disposed)
        this.pause(run, run.buddyId)
      return false
    }
  }

  async #steerCurrent(target: LocalChatQueueTarget, pending: QueuedTurnRequestInput, promoteNext = false): Promise<LocalChatQueueSteerResult> {
    const condition = this.#options.control?.queueTarget(target)
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
      if (!this.#deliver(input, execution.run.id, 'steer', promoteNext, condition))
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

  #deliver(input: QueuedTurnRequestInput, runId: string, mode: 'steer' | 'followUp', promoteNext = false, condition?: ReturnType<ChatControlCommandRepository['queueTarget']>) {
    this.#options.availability?.assertRunExecutable(runId)
    return this.#options.runner[mode](runId, () => {
      this.#options.availability?.assertRunExecutable(runId)
      const reference = this.#inputReference(input)
      this.#commitQueue(condition, () => this.#options.queue.commitInRun(input, runId, this.#options.getRunPermissionCeiling(runId), promoteNext))
      this.#changed('delivered', input, { commitId: randomUUID(), requestId: input.requestId, queueId: input.queuedMessageId!, runId, messageId: input.userMessageId, ...(input.attachmentBindings.length ? { attachmentOwnership: { kind: 'message', attachmentIds: input.attachmentBindings.map(binding => binding.id) } } : {}) })
      return reference
    }, input.runInput.contextItems.flatMap(item => item.kind === 'skill' && item.skill ? [item.skill] : []))
  }

  #inputReference(input: QueuedTurnRequestInput) {
    const documents = input.attachmentBindings.flatMap(binding => isDocumentMimeType(binding.mimeType)
      ? [{ attachmentId: binding.id, mimeType: binding.mimeType }]
      : [])
    return createBuddyInputReference({
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
  }

  reconcile(scope: LocalChatQueueScope) {
    return this.#serialize(scope, async () => {
      const current = this.#options.queue.continuationScope(scope)
      if (!current)
        return false
      if (this.#options.runner.hasDegradedCleanup(current.conversationId, current.branchId)) {
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
    const condition = this.#options.control?.queueTarget(target)
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
    const prepared = this.#commitQueue(condition, () => this.#options.requests.prepare({ ...input, createdAt: new Date().toISOString() }))
    this.#changed('dispatched', target)
    const turn = await this.#options.launcher.launch(prepared.runId, this.#stopping.signal)
    void turn.completion.catch(() => {})
    return true
  }

  #canDispatch(scope: QueuedTurnRequestInput): boolean {
    try {
      this.#options.control?.assertAccepting()
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
      && !this.#options.runner.hasActiveExecution(scope.conversationId, scope.buddyId, scope.branchId)
  }

  #commitQueue<T>(condition: ReturnType<ChatControlCommandRepository['queueTarget']> | undefined, operation: () => T): T {
    if (!this.#options.control)
      return operation()
    if (!condition)
      throw new BuddyServiceError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    return this.#options.control.withQueue(condition, operation)
  }

  #isCancelling(scope: LocalChatQueueScope, actorId?: string): boolean {
    return [...this.#cancellations.values()].some(cancellation => cancellation.conversationId === scope.conversationId && cancellation.branchId === scope.branchId && (!actorId || cancellation.buddyId === actorId))
  }

  #changed(kind: ChatQueueChange['kind'], scope: LocalChatQueueScope, committed?: ChatQueueChange['committed']): void {
    this.#changes.fire(copyEventSnapshot({ kind, scope: { conversationId: scope.conversationId, branchId: scope.branchId }, ...(committed ? { committed } : {}) }))
  }

  async #serialize<T>(scope: LocalChatQueueScope, operation: () => Promise<T>, disposed: T): Promise<T> {
    const key = JSON.stringify([scope.conversationId, scope.branchId])
    const previous = this.#operations.get(key)
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#operations.set(key, promise)
    await previous
    try {
      return this.#disposed ? disposed : await operation()
    }
    finally {
      if (this.#operations.get(key) === promise)
        this.#operations.delete(key)
      resolve()
    }
  }
}
