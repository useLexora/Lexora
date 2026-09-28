import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { SessionResourceReconciler } from '../agent/resources/SessionResourceReconciler'
import type { BuddySessionRegistry, DisposableBuddySession } from '../agent/sessions/BuddySessionRegistry'
import type { AutomationChangeCoordinator } from '../automations/AutomationChangeCoordinator'
import type { DirectoryGrantService } from '../directories/DirectoryGrantService'
import type { SpaceCommit, SpaceService } from './SpaceService'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'

interface SpaceDependentsOptions {
  source: Pick<SpaceService, 'onDidCommit' | 'list' | 'revision' | 'quiesce'>
  grants: Pick<DirectoryGrantService, 'onDidCommit' | 'quiesce'>
  sessions: Pick<BuddySessionRegistry<DisposableBuddySession>, 'snapshot' | 'onDidChange'>
  resources: Pick<SessionResourceReconciler<DisposableBuddySession>, 'reconcileInvalidation' | 'resync' | 'snapshot'>
  automations: Pick<AutomationChangeCoordinator, 'blockSpace'>
  record: ApplicationDiagnosticReporter
}

interface ReconciliationScope {
  kind: 'space' | 'directory'
  id: string
  revision: number
  deleted: boolean
  sessionIds: readonly string[]
}

export interface SpaceDependentsStatus {
  readonly status: 'ready' | 'pending' | 'degraded' | 'stopped'
  readonly revision: number
  readonly pending: number
}

export class SpaceDependents {
  readonly #options: SpaceDependentsOptions
  readonly #subscriptions: EventSubscription[]
  readonly #pending = new Set<Promise<unknown>>()
  readonly #affected = new Map<string, ReconciliationScope>()
  readonly #retryScopes = new Map<string, ReconciliationScope>()
  readonly #changes = new Emitter<SpaceDependentsStatus>(() => console.error('SPACE_DEPENDENTS_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #stopped = false

  constructor(options: SpaceDependentsOptions) {
    this.#options = { ...options, record: safeDiagnosticReporter(options.record) }
    this.#subscriptions = [
      options.source.onDidCommit(event => this.#committed(event)),
      options.grants.onDidCommit(event => this.#reconcile('directory', event.conversationId, event.revision, false)),
      options.sessions.onDidChange((event) => {
        if (!this.#affected.has(event.session.id))
          return
        const scope = this.#affected.get(event.session.id)!
        if (event.type === 'cleanup-failed')
          this.#retryScopes.set(`${scope.kind}:${scope.id}`, scope)
        if (event.type === 'disposed')
          this.#affected.delete(event.session.id)
        this.#publish()
      }),
    ]
  }

  get snapshot(): SpaceDependentsStatus {
    const affected = this.#options.sessions.snapshot().filter(session => this.#affected.has(session.id))
    const pending = this.#pending.size + affected.filter(session => session.invalidationPending || session.cleanup === 'pending').length
    const failed = this.#retryScopes.size > 0 || affected.some(session => session.cleanup === 'failed')
    return Object.freeze({ revision: this.#revision, pending, status: this.#stopped ? 'stopped' : failed ? 'degraded' : pending ? 'pending' : 'ready' })
  }

  async whenIdle(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  resync(): void {
    if (this.#stopped)
      return
    for (const scope of [...this.#retryScopes.values()])
      this.#reconcile(scope.kind, scope.id, scope.revision, scope.deleted, scope.sessionIds)
    for (const space of this.#options.source.list()) {
      if (space.revokedAt)
        this.#reconcile('space', space.id, this.#options.source.revision, true)
    }
  }

  async dispose(): Promise<void> {
    await this.#options.grants.quiesce()
    await this.#options.source.quiesce()
    await this.whenIdle()
    this.#stopped = true
    for (const subscription of this.#subscriptions) subscription.dispose()
    await this.whenIdle()
    this.#publish()
    this.#changes.dispose()
  }

  #committed(event: SpaceCommit): void {
    if (event.kind !== 'created' && event.facets.some(facet => facet !== 'presentation'))
      this.#reconcile('space', event.spaceId, event.revision, event.kind === 'deleted')
  }

  #reconcile(kind: 'space' | 'directory', id: string, revision: number, deleted: boolean, capturedSessionIds?: readonly string[]): void {
    if (this.#stopped)
      return
    const key = `${kind}:${id}`
    const sessionIds = capturedSessionIds ?? this.#options.sessions.snapshot().filter(session => kind === 'space' ? session.identity.spaceId === id : session.identity.conversationId === id).map(session => session.id)
    const scope = { kind, id, revision, deleted, sessionIds }
    for (const sessionId of sessionIds) this.#affected.set(sessionId, scope)
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => {
          if (deleted)
            this.#options.automations.blockSpace(id)
        }),
        (async () => {
          const receipt = await this.#options.resources.reconcileInvalidation({ source: kind, scope: id, revision: String(revision), sessionIds, matches: () => true, retry: true })
          if (kind === 'space' && !deleted) {
            await this.#options.resources.resync(id)
            if (this.#options.resources.snapshot().some(scope => scope.spaceId === id && scope.status === 'degraded'))
              throw new Error('SPACE_RESOURCES_DEGRADED')
          }
          if (receipt.degraded)
            throw new Error('SPACE_DEPENDENTS_CLEANUP_FAILED')
        })(),
      ])
      if (results.some(result => result.status === 'rejected'))
        throw new Error('SPACE_DEPENDENTS_RECONCILIATION_FAILED')
      if ((this.#retryScopes.get(key)?.revision ?? 0) <= revision)
        this.#retryScopes.delete(key)
    }).catch(() => {
      if ((this.#retryScopes.get(key)?.revision ?? 0) <= revision)
        this.#retryScopes.set(key, scope)
      this.#options.record({ event: 'directory.dependencies.degraded', level: 'warn', ...(kind === 'space' ? { spaceId: id } : { conversationId: id }) })
    }).finally(() => {
      this.#pending.delete(work)
      this.#publish()
    })
    this.#pending.add(work)
    this.#publish()
  }

  #publish(): void {
    this.#revision++
    this.#changes.fire(this.snapshot)
  }
}
