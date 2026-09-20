import type { LocalChatQueueScope, LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { BuddyStartTurnInput } from '../BuddyRuntime'
import type { ChatQueueRepository } from '../storage/chatQueueRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { PrepareTurnRequestInput, TurnRequestRepository } from '../storage/turnRequestRepository'
import type { ChatTurnService } from './ChatTurnService'
import { createHash } from 'node:crypto'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { createBuddyInputReference } from '../agent/context/BuddyInputReference'
import { getAttachmentLabels } from '../attachments/attachmentLabels'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { resolveTurnExecutionProfile } from '../storage/turnRequestRepository'

export interface ChatQueueServiceOptions {
  queue: ChatQueueRepository
  turns: Pick<ChatTurnService, 'prepareStart' | 'validatePreparedInput'>
  requests: Pick<TurnRequestRepository, 'prepare'>
  launcher: Pick<BuddyTurnLauncher, 'launch'>
  runner: Pick<BuddyAgentRunner, 'steer' | 'followUp'>
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'findById'>
}

export class ChatQueueService {
  readonly #options: ChatQueueServiceOptions
  readonly #operations = new Map<string, Promise<void>>()
  #disposed = false

  constructor(options: ChatQueueServiceOptions) {
    this.#options = options
    options.queue.pause()
  }

  dispose() {
    this.#disposed = true
  }

  list(scope: LocalChatQueueScope) {
    return this.#options.queue.list(scope)
  }

  async enqueue(input: BuddyStartTurnInput) {
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
      result = this.#options.queue.enqueue({ ...prepared, requestFingerprint: fingerprint })
    }
    catch (error) {
      await stagedAttachments.rollback()
      throw error
    }
    await stagedAttachments.commit().catch(() => undefined)
    this.#schedule(result)
    return result
  }

  cancel(target: LocalChatQueueTarget) {
    const cancelled = this.#options.queue.cancel(target)
    if (cancelled)
      this.#schedule(target)
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
      if (this.#disposed || !this.#options.queue.pending(target) || this.#options.queue.activeRun(target)?.id !== active.id)
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
        if (this.#disposed || signal.aborted)
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
        this.#options.queue.pause(run.conversationId)
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
      return reference
    }, input.runInput.contextItems.flatMap(item => item.kind === 'skill' && item.skill ? [item.skill] : []))
  }

  onRunSettled(runId: string) {
    if (this.#disposed)
      return
    const run = this.#options.runs.findById(runId)
    if (!run)
      return
    if (run.status !== 'completed') {
      this.#options.queue.pause(run.conversationId)
      return
    }
    this.#schedule(run)
  }

  #schedule(scope: LocalChatQueueScope) {
    setTimeout(() => {
      void this.#dispatchNext(scope).catch(() => {
        if (!this.#disposed)
          this.#options.queue.pause(scope.conversationId)
      })
    }, 0)
  }

  #dispatchNext(scope: LocalChatQueueScope) {
    return this.#serialize(scope, async () => {
      if (this.#options.queue.activeRun(scope))
        return false
      const next = this.#options.queue.list(scope)[0]
      return next?.state === 'waiting' ? this.#dispatch(next) : false
    })
  }

  async #dispatch(target: LocalChatQueueTarget, allowPaused = false) {
    if (this.#disposed || this.#options.queue.activeRun(target))
      return false
    const input = this.#options.queue.pending(target)
    if (!input)
      return false
    await this.#options.turns.validatePreparedInput(input)
    if (this.#disposed || !this.#options.queue.pending(target) || this.#options.queue.activeRun(target))
      return false
    const head = this.#options.queue.list(target)[0]
    if (!allowPaused && (head?.id !== target.id || head.state !== 'waiting'))
      return false
    const prepared = this.#options.requests.prepare({ ...input, createdAt: new Date().toISOString() })
    const turn = await this.#options.launcher.launch(prepared.runId)
    void turn.completion.then(() => this.onRunSettled(turn.runId), () => {
      if (!this.#disposed)
        this.#options.queue.pause(target.conversationId)
    })
    return true
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
