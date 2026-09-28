import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { SessionResourceReconciler } from '../agent/resources/SessionResourceReconciler'
import type { BuddySessionRegistry, DisposableBuddySession } from '../agent/sessions/BuddySessionRegistry'
import type { AutomationChangeCoordinator } from '../automations/AutomationChangeCoordinator'
import type { ProviderService } from './ProviderService'
import type { ProviderCommit } from './ProviderState'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'

interface ProviderDependentsOptions {
  source: Pick<ProviderService, 'snapshot' | 'onDidCommit' | 'onDidChangeCredential'> & Partial<Pick<ProviderService, 'whenIdle' | 'quiesce'>>
  sessions: Pick<BuddySessionRegistry<DisposableBuddySession>, 'snapshot' | 'onDidChange'>
  resources: Pick<SessionResourceReconciler<DisposableBuddySession>, 'reconcileInvalidation'>
  automations: Pick<AutomationChangeCoordinator, 'blockPinnedModel'>
  record: ApplicationDiagnosticReporter
}
export interface ProviderDependentsStatus {
  readonly status: 'ready' | 'pending' | 'degraded' | 'stopped'
  readonly pending: number
  readonly revision: number
}

export class ProviderDependents {
  readonly #options: ProviderDependentsOptions
  readonly #subscriptions: EventSubscription[]
  readonly #pending = new Set<Promise<unknown>>()
  readonly #affected = new Set<string>()
  readonly #changes = new Emitter<ProviderDependentsStatus>(() => console.error('PROVIDER_DEPENDENTS_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #failed = false
  #stopped = false
  #revision = 0

  constructor(options: ProviderDependentsOptions) {
    this.#options = { ...options, record: safeDiagnosticReporter(options.record) }
    this.#subscriptions = [
      options.sessions.onDidChange((event) => {
        if (this.#affected.has(event.session.id)) {
          if (event.session.status === 'disposed' && event.session.cleanup !== 'failed')
            this.#affected.delete(event.session.id)
          this.#publish()
        }
      }),
      options.source.onDidCommit(event => this.#committed(event)),
      options.source.onDidChangeCredential((event) => {
        if (event.kind !== 'observation' || event.current.presence === 'unknown')
          return
        const { providerId, presence, revision } = event.current
        if (presence === 'absent')
          this.#block(providerId)
        this.#invalidate(`credential:${providerId}`, String(revision), model => model.providerId === providerId)
      }),
    ]
  }

  get snapshot(): ProviderDependentsStatus {
    const affected = this.#options.sessions.snapshot().filter(session => this.#affected.has(session.id))
    const pending = this.#pending.size + affected.filter(session => session.invalidationPending || session.cleanup === 'pending').length
    const failed = this.#failed || affected.some(session => session.cleanup === 'failed')
    return Object.freeze({ status: this.#stopped ? 'stopped' : failed ? 'degraded' : pending ? 'pending' : 'ready', pending, revision: this.#revision })
  }

  async whenIdle(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  async dispose(): Promise<void> {
    try {
      if (this.#options.source.quiesce)
        await this.#options.source.quiesce()
      else await this.#options.source.whenIdle?.()
    }
    finally {
      this.#stopped = true
      for (const subscription of this.#subscriptions) subscription.dispose()
      await this.whenIdle()
      this.#publish()
      this.#changes.dispose()
    }
  }

  reconcile(): void {
    if (this.#stopped)
      return
    this.#failed = false
    const snapshot = this.#options.source.snapshot
    for (const provider of snapshot.providers) {
      if (!provider.enabled)
        this.#block(provider.id)
    }
    for (const model of snapshot.models) {
      if (!model.enabled || !model.available)
        this.#block(model.providerId, model.id)
    }
    this.#invalidate('reconcile', String(snapshot.revision), () => true)
  }

  #committed(event: ProviderCommit): void {
    if (this.#stopped)
      return
    for (const provider of event.providers) {
      if (!provider.enabled)
        this.#block(provider.providerId)
    }
    for (const model of event.models) {
      if (!model.current?.enabled || !model.current.available)
        this.#block(model.providerId, model.modelId)
    }
    const providers = new Set(event.providers.filter(provider => provider.executionChanged).map(provider => provider.providerId))
    const models = new Set(event.models.filter(model => model.facets.some(facet => facet === 'execution' || facet === 'availability')).map(model => JSON.stringify([model.providerId, model.modelId])))
    if (providers.size || models.size)
      this.#invalidate('catalog', String(event.revision), model => providers.has(model.providerId) || models.has(JSON.stringify([model.providerId, model.modelId])))
  }

  #block(providerId: string, modelId?: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.#options.automations.blockPinnedModel(providerId, modelId)
        return
      }
      catch {
        if (attempt === 2)
          this.#fail()
      }
    }
  }

  #invalidate(scope: string, revision: string, matches: (model: { providerId: string, modelId: string }) => boolean): void {
    if (this.#stopped)
      return
    const sessionIds = this.#options.sessions.snapshot().filter(session => this.#affected.has(session.id) || (scope !== 'reconcile' && (session.model ? matches(session.model) : session.status === 'pending'))).map(session => session.id)
    if (!sessionIds.length) {
      this.#publish()
      return
    }
    for (const id of sessionIds) this.#affected.add(id)
    const work = Promise.resolve().then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.#options.resources.reconcileInvalidation({ source: 'provider', scope, revision, sessionIds, matches: () => true, retry: scope === 'reconcile' || attempt > 0 })
        }
        catch (error) {
          if (attempt >= 2)
            throw error
        }
      }
    }).then((result) => {
      if (result.degraded)
        this.#fail()
    }, () => this.#fail()).finally(() => {
      this.#pending.delete(work)
      this.#publish()
    })
    this.#pending.add(work)
    this.#publish()
  }

  #fail(): void {
    this.#failed = true
    this.#options.record({ event: 'provider.dependencies.degraded', level: 'warn' })
    this.#publish()
  }

  #publish(): void {
    this.#revision++
    this.#changes.fire(this.snapshot)
  }
}
