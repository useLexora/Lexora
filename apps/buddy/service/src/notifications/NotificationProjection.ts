import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { Event } from '../../../shared/events/Emitter'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { AutomationService } from '../automations/AutomationService'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { ProviderService } from '../providers/ProviderService'
import type { RunLifecycleService } from '../runs/RunLifecycleService'
import type { AttentionNotificationService } from './AttentionNotificationService'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'

export class NotificationProjection {
  readonly #subscriptions: EventSubscription[]
  readonly #source: Pick<AttentionNotificationService, 'reconcile'>
  readonly #record: ApplicationDiagnosticReporter
  readonly #changes = new Emitter<{ readonly status: 'ready' | 'pending' | 'degraded' | 'stopped' }>(() => console.error('NOTIFICATION_PROJECTION_OBSERVER_FAILED'))
  readonly onDidChange: Event<{ readonly status: 'ready' | 'pending' | 'degraded' | 'stopped' }> = this.#changes.event
  #status: 'ready' | 'pending' | 'degraded' | 'stopped' = 'ready'
  #pending: Promise<void> | undefined
  #dirty = false
  #stopping = false

  constructor(options: {
    service: Pick<AttentionNotificationService, 'reconcile'>
    providers: Pick<ProviderService, 'onDidCommit'>
    automations: Pick<AutomationService, 'onDidCommit'>
    runs: RunEventObservation
    lifecycle: Pick<RunLifecycleService, 'onDidReconcile'>
    record: ApplicationDiagnosticReporter
  }) {
    this.#source = options.service
    this.#record = safeDiagnosticReporter(options.record)
    this.#subscriptions = [
      options.providers.onDidCommit((event) => {
        if (event.models.length)
          this.reconcile()
      }),
      options.automations.onDidCommit((event) => {
        if (event.facts.some(fact => fact.kind === 'occurrence.finished' || fact.kind === 'occurrence.deleted'))
          this.reconcile()
      }),
      options.runs.onDidCommit((event) => {
        if (event.type === 'run.completed' || event.type === 'run.failed')
          this.reconcile()
      }),
      options.lifecycle.onDidReconcile(() => this.reconcile()),
    ]
    this.reconcile()
  }

  get snapshot() { return Object.freeze({ status: this.#status }) }

  reconcile(): void {
    if (this.#stopping)
      return
    this.#dirty = true
    this.#schedule()
  }

  #schedule(): void {
    if (this.#pending)
      return
    this.#pending = Promise.resolve().then(() => {
      while (this.#dirty) {
        this.#dirty = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            this.#source.reconcile()
            this.#setStatus('ready')
            break
          }
          catch {
            if (attempt === 2) {
              this.#setStatus('degraded')
              this.#record({ event: 'notifications.projection.degraded', level: 'warn' })
            }
          }
        }
      }
    }).finally(() => {
      this.#pending = undefined
      if (this.#dirty)
        this.#schedule()
    })
    this.#setStatus('pending')
  }

  async whenIdle(): Promise<void> {
    while (this.#pending) await this.#pending
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await this.whenIdle()
    for (const subscription of this.#subscriptions) subscription.dispose()
    this.#setStatus('stopped')
    this.#changes.dispose()
  }

  #setStatus(status: 'ready' | 'pending' | 'degraded' | 'stopped'): void {
    if (this.#status === status)
      return
    this.#status = status
    this.#changes.fire(this.snapshot)
  }
}
