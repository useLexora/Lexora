import type { DatabaseSync } from 'node:sqlite'
import type { CommandAdmissionService } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { ApprovalRecord, ApprovalRepository } from '../storage/approvalRepository'
import type { CommandRejection } from '../storage/CommandCommitter'
import type { ApprovalResolutionDecision } from './ApprovalService'
import { SqliteRunEventWriter } from '../events/SqliteRunEventWriter'
import { getStorageIsolation } from '../storage/StorageIsolation'
import { afterTransactionCommit, withTransaction } from '../storage/transaction'

export interface ApprovalCommandAdmission {
  database: DatabaseSync
  admission: CommandAdmissionService
  events?: SqliteRunEventWriter
}

export interface ApprovalCommandDecision {
  allows: (resolution: ApprovalResolutionDecision) => boolean
  release: (resolution: ApprovalResolutionDecision) => Promise<void>
}

interface ApprovalCommandOptions extends ApprovalCommandAdmission {
  repository: Pick<ApprovalRepository, 'findById'>
  lifecycle: {
    activate: (approvalId: string) => void
    captureDecision: (approval: ApprovalRecord) => ApprovalCommandDecision | null
    expire: (approval: ApprovalRecord) => void | Promise<void>
  }
  onObserverError?: (error: unknown) => void
}

export class ApprovalCommandService {
  readonly #options: ApprovalCommandOptions
  readonly #events: SqliteRunEventWriter
  readonly #onObserverError: (error: unknown) => void
  readonly #effects = new Set<Promise<void>>()

  constructor(options: ApprovalCommandOptions) {
    this.#options = options
    this.#events = options.events ?? new SqliteRunEventWriter(options.database, options.onObserverError)
    this.#onObserverError = options.onObserverError ?? (() => {})
  }

  get storageFailure(): Error | null {
    return getStorageIsolation(this.#options.database).failure
  }

  appendRequested(approval: ApprovalRecord): Promise<unknown> {
    const event = withTransaction(this.#options.database, () => {
      afterTransactionCommit(this.#options.database, () => this.#options.lifecycle.activate(approval.id), this.#onObserverError)
      return this.#events.append({ runId: approval.runId, type: 'approval.requested', payload: approval })
    })
    return Promise.resolve(event)
  }

  resolve(input: unknown, admission = this.#options.admission) {
    let accepted: { pending: ApprovalRecord, effect: ApprovalCommandDecision } | undefined
    return admission.execute('approvals.resolve', input, {
      prepare: async intent => intent,
      validate: (intent, command) => {
        const decision = this.#validate(intent, command.actorId)
        if ('rejection' in decision)
          return decision.rejection
        accepted = decision
        return null
      },
      commit: (intent, command) => {
        const { pending, effect } = accepted!
        const status = intent.decision === 'denied' ? 'denied' : 'approved'
        const resolvedAt = new Date().toISOString()
        this.#events.append({ runId: pending.runId, type: 'approval.resolved', payload: {
          id: pending.id,
          resolution: intent.decision,
          status,
          resolvedAt,
          actorId: command.actorId,
        } })
        afterTransactionCommit(this.#options.database, () => this.#runEffect(() => effect.release(intent.decision)), this.#onObserverError)
        return { target: { approvalId: pending.id, runId: pending.runId }, result: { status, resolution: intent.decision, reviewVersion: intent.reviewVersion, resolvedAt } }
      },
    })
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.#effects)
  }

  dispose(): void {
    if (!this.#options.events)
      this.#events.dispose()
  }

  #validate(intent: Readonly<InputCommandIntent<'approvals.resolve'>>, actorId: string): { rejection: CommandRejection } | { pending: ApprovalRecord, effect: ApprovalCommandDecision } {
    const pending = this.#options.repository.findById(intent.approvalId)
    const target = { approvalId: intent.approvalId, runId: intent.runId }
    const rejected = (errorCode: CommandRejection['errorCode'], reason: string): { rejection: CommandRejection } => ({ rejection: { errorCode, target, result: { reason, status: pending?.status ?? null, resolution: pending?.resolution ?? null } } })
    if (!pending)
      return rejected('OBJECT_DELETED', 'approval_missing')
    if (pending.status !== 'pending')
      return rejected('APPROVAL_ALREADY_RESOLVED', 'already_resolved')
    if (pending.runId !== intent.runId || !pending.review || pending.review.reviewVersion !== intent.reviewVersion)
      return rejected('REVIEW_CHANGED', 'review_mismatch')
    if (Date.now() >= Date.parse(pending.review.expiresAt)) {
      this.#expire(pending)
      return { rejection: { errorCode: 'APPROVAL_ALREADY_RESOLVED', target, result: { reason: 'expired', status: 'cancelled', resolution: 'cancelled' } } }
    }
    const effect = this.#options.lifecycle.captureDecision(pending)
    if (!effect)
      return rejected('RESOURCE_UNAVAILABLE', 'waiter_unavailable')
    const run = this.#options.database.prepare('SELECT status FROM runs WHERE id = ?').get(pending.runId)
    if (!run || !['queued', 'running'].includes(String(run.status)))
      return rejected('RESOURCE_UNAVAILABLE', 'run_unavailable')
    if (!pending.review.allowedDecisions.includes(intent.decision) || (intent.decision !== 'denied' && !pending.review.complete))
      return rejected('REVIEW_CHANGED', 'decision_not_allowed')
    const localActor = this.#options.database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()!.local_actor_id
    if (intent.decision !== 'denied' && pending.review.persistentEffect && actorId !== localActor)
      return rejected('REVIEW_CHANGED', 'local_authorization_required')
    if (!effect.allows(intent.decision))
      return rejected('REVIEW_CHANGED', 'decision_not_allowed')
    return { pending, effect }
  }

  #runEffect(operation: () => void | Promise<void>): void {
    const effect = Promise.resolve(operation())
    this.#effects.add(effect)
    void effect.finally(() => this.#effects.delete(effect)).catch(this.#onObserverError)
  }

  #expire(approval: ApprovalRecord): void {
    this.#events.append({ runId: approval.runId, type: 'approval.resolved', payload: {
      id: approval.id,
      status: 'cancelled',
      resolution: 'cancelled',
      cancellationReason: 'expired',
      resolvedAt: new Date().toISOString(),
    } })
    afterTransactionCommit(this.#options.database, () => this.#runEffect(() => this.#options.lifecycle.expire(approval)), this.#onObserverError)
  }
}
