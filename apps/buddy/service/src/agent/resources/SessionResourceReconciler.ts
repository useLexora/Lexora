import type { Event, ListenerErrorHandler } from '../../../../shared/events/Emitter'
import type { EventSubscription } from '../../../../shared/events/eventTypes'
import type { SkillService } from '../../skills/SkillService'
import type { BuddyCapabilityResourceRevision } from '../extensions/BuddyCapability'
import type { BuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import type { BuddySessionInvalidationResult, BuddySessionRegistry, BuddySessionSnapshot, DisposableBuddySession } from '../sessions/BuddySessionRegistry'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'

export interface SessionResourceScope {
  readonly spaceId: string | null
  readonly skillRevision: string | null
  readonly status: 'current' | 'pending' | 'degraded'
  readonly pending: number
  readonly degraded: number
}

export type SessionResourceChange
  = | { readonly type: 'external-invalidation', readonly source: 'provider' | 'connector' | 'space' | 'directory', readonly result: BuddySessionInvalidationResult }
    | { readonly type: 'desired', readonly scope: SessionResourceScope }
    | { readonly type: 'invalidation', readonly scope: SessionResourceScope }
    | { readonly type: 'resolution-failed', readonly scope: SessionResourceScope, readonly error: 'SESSION_RESOURCE_RESOLUTION_FAILED' }
    | { readonly type: 'applied', readonly sessionId: string, readonly spaceId: string | null, readonly resourceRevision: string, readonly skillRevision: string | null, readonly capabilityRevisions: readonly BuddyCapabilityResourceRevision[] }

export interface SessionResourceInvalidation {
  readonly source: 'provider' | 'connector' | 'space' | 'directory'
  readonly scope: string
  readonly revision: string
  readonly retry?: boolean
  readonly sessionIds?: readonly string[]
  readonly matches: (identity: Readonly<BuddySessionIdentity>) => boolean
}

interface SessionResourceReconcilerOptions<TSession extends DisposableBuddySession> {
  skills: Pick<SkillService, 'onDidCommitInstallation' | 'onDidChangeResources' | 'loadForSpace' | 'resourceSnapshots' | 'quiesce'>
  sessions: BuddySessionRegistry<TSession>
  onListenerError?: ListenerErrorHandler
}

export class SessionResourceReconciler<TSession extends DisposableBuddySession> {
  readonly #options: SessionResourceReconcilerOptions<TSession>
  readonly #changes: Emitter<SessionResourceChange>
  readonly #subscriptions: EventSubscription[]
  readonly #scopes = new Map<string | null, SessionResourceScope>()
  readonly #refreshScopes = new Set<string | null>()
  readonly #resolutionFailures = new Set<string | null>()
  readonly #external = new Map<string, { revision: string, result: Promise<BuddySessionInvalidationResult> }>()
  #refreshQueued = false
  #tail = Promise.resolve()
  #disposed = false

  constructor(options: SessionResourceReconcilerOptions<TSession>) {
    this.#options = options
    this.#changes = new Emitter(options.onListenerError ?? (() => console.error('SESSION_RESOURCE_OBSERVER_FAILED')))
    this.#subscriptions = [
      options.skills.onDidCommitInstallation(event => this.#refresh(event.spaceId)),
      options.skills.onDidChangeResources(event => this.#accept(event.spaceId, event.resourceRevision)),
      options.sessions.onDidChange((event) => {
        const { session } = event
        if (event.type === 'ready')
          this.#applied(session)
        if (event.type === 'registered' || event.type === 'ready')
          this.#enqueue(() => this.#reconcile(session.identity.spaceId))
        this.#updateStatus(session.identity.spaceId)
      }),
    ]
    for (const { spaceId, resolution } of options.skills.resourceSnapshots())
      this.#accept(spaceId, resolution.revision)
    for (const session of options.sessions.snapshot()) {
      if (session.status === 'ready')
        this.#applied(session)
      if (!this.#scopes.has(session.identity.spaceId))
        this.#refresh(session.identity.spaceId)
    }
  }

  readonly onDidChange: Event<SessionResourceChange> = (listener, options) => this.#changes.event(listener, options)

  snapshot(): readonly SessionResourceScope[] {
    return Object.freeze([...this.#scopes.values()])
  }

  async whenIdle(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.#tail
      await pending
    } while (pending !== this.#tail)
  }

  resync(spaceId: string | null = null): Promise<void> {
    if (!this.#disposed)
      this.#refresh(spaceId)
    return this.whenIdle()
  }

  reconcileInvalidation(input: SessionResourceInvalidation): Promise<BuddySessionInvalidationResult> {
    const key = `${input.source}\0${input.scope}`
    const previous = this.#external.get(key)
    if (previous?.revision === input.revision && !input.retry)
      return previous.result
    const sessionIds = input.sessionIds ? [...input.sessionIds] : undefined
    const result = this.#tail.then(async () => {
      if (this.#disposed || this.#external.get(key)?.result !== result)
        return Object.freeze({ matched: 0, pending: 0, degraded: 0 })
      const receipt = await this.#options.sessions.invalidateMatching(input.matches, sessionIds ? { sessionIds } : undefined)
      if (!this.#disposed)
        this.#changes.fire(Object.freeze({ type: 'external-invalidation', source: input.source, result: receipt }))
      return receipt
    })
    this.#external.set(key, { revision: input.revision, result })
    this.#tail = result.then((receipt) => {
      if (receipt.degraded && this.#external.get(key)?.result === result)
        this.#external.delete(key)
    }, () => {
      if (this.#external.get(key)?.result === result)
        this.#external.delete(key)
    })
    return result
  }

  async dispose(): Promise<void> {
    await this.#options.skills.quiesce()
    await this.whenIdle()
    this.#disposed = true
    for (const subscription of this.#subscriptions)
      subscription.dispose()
    await this.whenIdle()
    this.#changes.dispose()
    this.#refreshScopes.clear()
    this.#external.clear()
  }

  #refresh(spaceId: string | null): void {
    if (spaceId === null) {
      this.#refreshScopes.add(null)
      for (const scope of this.#scopes.keys())
        this.#refreshScopes.add(scope)
      for (const session of this.#options.sessions.snapshot())
        this.#refreshScopes.add(session.identity.spaceId)
    }
    else {
      this.#refreshScopes.add(spaceId)
    }
    if (this.#refreshQueued)
      return
    this.#refreshQueued = true
    this.#enqueue(async () => {
      this.#refreshQueued = false
      const scopes = [...this.#refreshScopes]
      this.#refreshScopes.clear()
      for (const scope of scopes) {
        if (this.#disposed)
          return
        try {
          const resolution = await this.#options.skills.loadForSpace(scope)
          this.#accept(scope, resolution.revision)
        }
        catch {
          this.#resolutionFailed(scope)
        }
      }
    })
  }

  #accept(spaceId: string | null, revision: string): void {
    if (this.#disposed)
      return
    this.#resolutionFailures.delete(spaceId)
    if (this.#scopes.get(spaceId)?.skillRevision === revision) {
      this.#updateStatus(spaceId)
      return
    }
    const scope = copyEventSnapshot({ spaceId, skillRevision: revision, ...this.#status(spaceId, revision) })
    this.#scopes.set(spaceId, scope)
    this.#changes.fire(Object.freeze({ type: 'desired', scope }))
    this.#enqueue(() => this.#reconcile(spaceId))
  }

  async #reconcile(spaceId: string | null): Promise<void> {
    const revision = this.#scopes.get(spaceId)?.skillRevision
    if (!revision || this.#disposed)
      return
    await this.#options.sessions.invalidateMatching(identity => identity.spaceId === spaceId && identity.skillRevision !== revision)
    if (!this.#disposed)
      this.#updateStatus(spaceId)
  }

  #updateStatus(spaceId: string | null): void {
    const previous = this.#scopes.get(spaceId)
    if (!previous || this.#disposed)
      return
    const status = this.#status(spaceId, previous.skillRevision)
    if (previous.status === status.status && previous.pending === status.pending && previous.degraded === status.degraded)
      return
    const scope = copyEventSnapshot({ ...previous, ...status })
    this.#scopes.set(spaceId, scope)
    this.#changes.fire(Object.freeze({ type: 'invalidation', scope }))
  }

  #status(spaceId: string | null, revision: string | null): Pick<SessionResourceScope, 'status' | 'pending' | 'degraded'> {
    const affected = this.#options.sessions.snapshot().filter(session => session.identity.spaceId === spaceId && session.identity.skillRevision !== revision)
    const failedCleanup = affected.filter(session => session.cleanup === 'failed').length
    const degraded = failedCleanup + Number(this.#resolutionFailures.has(spaceId))
    const pending = affected.length - failedCleanup
    return { status: degraded ? 'degraded' : pending ? 'pending' : 'current', pending, degraded }
  }

  #resolutionFailed(spaceId: string | null): void {
    if (this.#disposed)
      return
    this.#resolutionFailures.add(spaceId)
    const previous = this.#scopes.get(spaceId)
    const scope = copyEventSnapshot({ spaceId, skillRevision: previous?.skillRevision ?? null, status: 'degraded' as const, pending: previous?.pending ?? 0, degraded: Math.max(1, previous?.degraded ?? 0) })
    this.#scopes.set(spaceId, scope)
    this.#changes.fire(Object.freeze({ type: 'resolution-failed', scope, error: 'SESSION_RESOURCE_RESOLUTION_FAILED' }))
  }

  #applied(session: BuddySessionSnapshot): void {
    this.#changes.fire(Object.freeze({ type: 'applied', sessionId: session.id, spaceId: session.identity.spaceId, resourceRevision: session.identity.resourceRevision, skillRevision: session.identity.skillRevision ?? null, capabilityRevisions: session.resourceRevisions }))
  }

  #enqueue(action: () => Promise<void>): void {
    this.#tail = this.#tail.then(async () => {
      if (!this.#disposed)
        await action()
    }).catch(() => {
      if (!this.#disposed)
        console.error('SESSION_RESOURCE_RECONCILIATION_FAILED')
    })
  }
}
