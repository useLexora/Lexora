import type { LocalChatQueueReceipt, LocalChatQueueScope, LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { BuddyStartTurnInput } from '../BuddyRuntime'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { ChatQueueRepository } from '../storage/chatQueueRepository'
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
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { resolveTurnExecutionProfile } from '../storage/turnRequestRepository'

export interface ChatQueueServiceOptions {
  queue: ChatQueueRepository
  turns: Pick<ChatTurnService, 'prepareStart' | 'validatePreparedInput'>
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
    await Promise.allSettled([...this.#operations.values(), ...this.#enqueues])
  }

  continuationScopes(): LocalChatQueueScope[] {
    return this.#options.queue.continuationScopes()
  }

  pause(scope: LocalChatQueueScope): void {
    if (this.#disposed)
      return
    if (this.#options.queue.pause(scope.conversationId))
      this.#changed('paused', scope)
  }

  list(scope: LocalChatQueueScope) {
    return this.#options.queue.list(scope)
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
    const fingerprint = createHash('sha256').update(JSON.stringify([input.draftId, input.expectedRevision])).digest('hex')
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
      stagedAttachments.validate()
      result = this.#options.queue.enqueue({ ...prepared, requestFingerprint: fingerprint })
    }
    catch (error) {
      await stagedAttachments.rollback()
      throw error
    }
    this.#changed('enqueued', result, { commitId: randomUUID(), requestId: input.requestId, queueId: result.id, draftReceipt: result.draftReceipt, ...(prepared.attachmentBindings.length ? { attachmentOwnership: { kind: 'queue', attachmentIds: prepared.attachmentBindings.map(binding => binding.id) } } : {}) })
    await stagedAttachments.commit().catch(() => undefined)
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

  steer(target: LocalChatQueueTarget) {
    const active = this.#options.queue.activeRun(target)
    return this.#serialize(target, async () => {
      if (!active)
        return this.#dispatch(target, true)
      const input = this.#options.queue.pending(target)
      if (!input || this.#options.queue.activeRun(target)?.id !== active.id)
        return false
      if (active.purpose !== 'chat' || active.model !== input.model || active.provider !== input.provider)
        throw new BuddyServiceError('VALIDATION_FAILED')
      const run = this.#options.runs.findById(active.id)
      if (!run || run.approvalPolicy !== input.approvalPolicy || run.executionProfile !== resolveTurnExecutionProfile(input))
        return false
      await this.#options.turns.validatePreparedInput(input, false)
      if (this.#disposed || this.#options.eventLog.state !== 'open' || !this.#options.queue.pending(target) || this.#options.queue.activeRun(target)?.id !== active.id)
        return false
      return this.#deliver(input, active.id, 'steer')
    })
  }

  async followUp(runId: string, signal: AbortSignal) {
    const run = this.#options.runs.findById(runId)
    if (!run || run.purpose !== 'chat')
      return false
    try {
      return await this.#serialize(run, async () => {
        if (signal.aborted || this.#options.queue.activeRun(run)?.id !== runId)
          return false
        const next = this.#options.queue.list(run)[0]
        if (next?.state !== 'waiting')
          return false
        const input = this.#options.queue.pending(next)
        if (!input || !this.#canFollowUp(run, input))
          return false
        await this.#options.turns.validatePreparedInput(input)
        if (this.#disposed || this.#options.eventLog.state !== 'open' || signal.aborted)
          return false
        const head = this.#options.queue.list(run)[0]
        if (this.#options.queue.activeRun(run)?.id !== runId
          || head?.id !== next.id || head.state !== 'waiting'
          || !this.#options.queue.pending(next)) {
          return false
        }
        return this.#deliver(input, runId, 'followUp')
      })
    }
    catch {
      if (!this.#disposed)
        this.pause(run)
      return false
    }
  }

  #canFollowUp(run: RunRecord, input: PrepareTurnRequestInput) {
    const current = this.#options.runInputs.findByRunId(run.id)
    return run.status === 'running' && run.branchId === input.branchId
      && run.model === input.model && run.provider === input.provider
      && run.approvalPolicy === input.approvalPolicy && run.executionProfile === resolveTurnExecutionProfile(input)
      && run.contextWindow === (input.modelParameters?.contextWindow ?? null)
      && run.maxTokens === (input.modelParameters?.maxTokens ?? null)
      && current?.reasoning === input.runInput.reasoning && current.serviceTier === input.runInput.serviceTier
  }

  #deliver(input: PrepareTurnRequestInput, runId: string, mode: 'steer' | 'followUp') {
    return this.#options.runner[mode](runId, () => {
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
      this.#options.queue.commitInRun(input, runId)
      this.#changed('delivered', input, { commitId: randomUUID(), requestId: input.requestId, queueId: input.queuedMessageId!, runId, messageId: input.userMessageId, ...(input.attachmentBindings.length ? { attachmentOwnership: { kind: 'message', attachmentIds: input.attachmentBindings.map(binding => binding.id) } } : {}) })
      return reference
    }, input.runInput.contextItems.flatMap(item => item.kind === 'skill' && item.skill ? [item.skill] : []))
  }

  reconcile(scope: LocalChatQueueScope) {
    return this.#serialize(scope, async () => {
      const current = this.#options.queue.continuationScope(scope.conversationId)
      if (!current || !this.#canDispatch(current))
        return false
      const latest = this.#options.queue.latestRun(current)
      if ((latest && latest.status !== 'completed') || this.#options.runner.hasDegradedCleanup(current.conversationId)) {
        this.pause(current)
        return false
      }
      const next = this.#options.queue.list(current)[0]
      return next?.state === 'waiting' ? this.#dispatch(next) : false
    })
  }

  async #dispatch(target: LocalChatQueueTarget, allowPaused = false) {
    if (!this.#canDispatch(target))
      return false
    const input = this.#options.queue.pending(target)
    if (!input)
      return false
    await this.#options.turns.validatePreparedInput(input)
    if (!this.#canDispatch(target) || !this.#options.queue.pending(target))
      return false
    const head = this.#options.queue.list(target)[0]
    if (!allowPaused && (head?.id !== target.id || head.state !== 'waiting'))
      return false
    const prepared = this.#options.requests.prepare({ ...input, createdAt: new Date().toISOString() })
    this.#changed('dispatched', target)
    const turn = await this.#options.launcher.launch(prepared.runId, this.#stopping.signal)
    void turn.completion.catch(() => {})
    return true
  }

  #canDispatch(scope: LocalChatQueueScope): boolean {
    return !this.#disposed && !this.#options.runner.isStopping && this.#options.eventLog.state === 'open'
      && !this.#options.queue.activeRun(scope)
      && !this.#options.runner.hasActiveExecution(scope.conversationId)
  }

  #changed(kind: ChatQueueChange['kind'], scope: LocalChatQueueScope, committed?: ChatQueueChange['committed']): void {
    this.#changes.fire(copyEventSnapshot({ kind, scope: { conversationId: scope.conversationId, branchId: scope.branchId }, ...(committed ? { committed } : {}) }))
  }

  async #serialize(scope: LocalChatQueueScope, operation: () => Promise<boolean>): Promise<boolean> {
    const previous = this.#operations.get(scope.conversationId)
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#operations.set(scope.conversationId, promise)
    await previous
    try {
      return this.#disposed ? false : await operation()
    }
    finally {
      if (this.#operations.get(scope.conversationId) === promise)
        this.#operations.delete(scope.conversationId)
      resolve()
    }
  }
}
