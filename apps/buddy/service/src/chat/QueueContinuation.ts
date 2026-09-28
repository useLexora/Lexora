import type { LocalChatQueueScope } from '../../../shared/conversation/chatQueueApi'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { RunRepository } from '../storage/runRepository'
import type { ChatQueueService } from './ChatQueueService'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

type PendingScope = ({ scope: LocalChatQueueScope } | { runId: string }) & { attempts: number }

export interface QueueContinuationOptions {
  queue: Pick<ChatQueueService, 'onDidChange' | 'continuationScopes' | 'pause' | 'reconcile'>
  runner: Pick<BuddyAgentRunner, 'onDidSettle'>
  eventLog: RunEventObservation
  runs: Pick<RunRepository, 'findById'>
  record?: ApplicationDiagnosticReporter
}

export class QueueContinuation {
  readonly #options: QueueContinuationOptions
  readonly #record: ApplicationDiagnosticReporter
  readonly #subscriptions: EventSubscription[]
  readonly #dirty = new Map<string, PendingScope>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #state: 'starting' | 'ready' | 'degraded' | 'stopped' = 'starting'

  constructor(options: QueueContinuationOptions) {
    this.#options = options
    this.#record = safeDiagnosticReporter(options.record)
    this.#subscriptions = [
      options.queue.onDidChange((change) => {
        if (change.kind === 'enqueued' || change.kind === 'cancelled' || change.kind === 'dispatched')
          this.#request(change.scope)
      }),
      options.runner.onDidSettle((settled) => {
        this.#request(settled)
      }),
      options.eventLog.onDidCommit((event) => {
        if (!['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
          return
        if (this.#state !== 'stopped') {
          this.#dirty.set(`run:${event.runId}`, { runId: event.runId, attempts: 0 })
          this.#schedule()
        }
      }),
    ]
    this.reconcile()
  }

  get state(): 'starting' | 'ready' | 'degraded' | 'stopped' {
    return this.#state
  }

  async start(): Promise<void> {
    if (this.#timer)
      clearTimeout(this.#timer)
    this.#timer = null
    if (!this.#running) {
      this.#running = this.#drain().finally(() => {
        this.#running = null
        this.#schedule()
      })
    }
    await this.#running
    if (this.#state === 'degraded')
      throw new Error('QUEUE_RECONCILIATION_FAILED')
  }

  reconcile(): void {
    if (this.#state === 'stopped')
      return
    for (const pending of this.#dirty.values())
      pending.attempts = 0
    for (const scope of this.#options.queue.continuationScopes())
      this.#request(scope)
    if (this.#dirty.size === 0)
      this.#state = 'ready'
    else
      this.#schedule()
  }

  async dispose(): Promise<void> {
    this.#state = 'stopped'
    if (this.#timer)
      clearTimeout(this.#timer)
    this.#timer = null
    for (const subscription of this.#subscriptions)
      subscription.dispose()
    this.#dirty.clear()
    await this.#running
  }

  #request(scope: LocalChatQueueScope): void {
    if (this.#state === 'stopped')
      return
    this.#dirty.set(`conversation:${scope.conversationId}`, { scope: { conversationId: scope.conversationId, branchId: scope.branchId }, attempts: 0 })
    this.#schedule()
  }

  #schedule(): void {
    if (this.#state === 'stopped' || this.#timer || this.#running)
      return
    const pending = [...this.#dirty.values()].filter(pending => pending.attempts < 3)
    if (pending.length === 0)
      return
    const delay = Math.min(...pending.map(pending => pending.attempts)) * 50
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#running = this.#drain().finally(() => {
        this.#running = null
        this.#schedule()
      })
    }, delay)
  }

  async #drain(): Promise<void> {
    for (const [key, pending] of [...this.#dirty]) {
      if (this.#state === 'stopped')
        return
      if (pending.attempts >= 3)
        continue
      this.#dirty.delete(key)
      let scope: LocalChatQueueScope | null = 'scope' in pending ? pending.scope : null
      try {
        scope ??= 'runId' in pending ? this.#options.runs.findById(pending.runId) : null
        if (!scope)
          continue
        if (this.#options.eventLog.state !== 'open') {
          this.#options.queue.pause(scope)
          this.#dirty.set(key, { ...pending, attempts: 3 })
          this.#state = 'degraded'
          continue
        }
        await this.#options.queue.reconcile(scope)
        if (this.state === 'stopped')
          return
        if (this.#options.eventLog.state !== 'open') {
          this.#options.queue.pause(scope)
          this.#dirty.set(key, { ...pending, attempts: 3 })
          this.#state = 'degraded'
        }
      }
      catch {
        if (this.state === 'stopped')
          return
        this.#dirty.set(key, { ...pending, attempts: pending.attempts + 1 })
        this.#state = 'degraded'
        this.#record({ event: 'queue.reconcile_failed', level: 'error', conversationId: scope?.conversationId })
        try {
          if (scope)
            this.#options.queue.pause(scope)
        }
        catch {}
      }
    }
    if (this.#state !== 'stopped' && this.#dirty.size === 0)
      this.#state = 'ready'
  }
}
