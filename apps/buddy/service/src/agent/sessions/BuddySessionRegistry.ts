import type { Event, ListenerErrorHandler } from '../../../../shared/events/Emitter'
import type { BuddyCapabilityResourceRevision } from '../extensions/BuddyCapability'
import type { BuddySessionIdentity } from './BuddySessionBlueprint'
import type { BuddySessionShutdownReason } from './ReusableBuddySession'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'

export interface BuddySessionBinding<TSession> {
  readonly resourceRevisions?: readonly BuddyCapabilityResourceRevision[]
  readonly piSessionFile: string
  readonly recoveredFromProductHistory?: boolean
  readonly recoveryDegradation?: {
    readonly missingAttachmentIds: readonly string[]
    readonly recoveredImageCount: number
  }
  readonly session: TSession
}

export interface DisposableBuddySession {
  getModelUsage?: () => { readonly providerId: string, readonly modelId: string } | null
  shutdown: (reason: BuddySessionShutdownReason) => Promise<void>
}

interface BuddySessionEntry<TSession> {
  id: string
  identity: Readonly<BuddySessionIdentity>
  binding: BuddySessionBinding<TSession> | null
  promise: Promise<BuddySessionBinding<TSession>>
  requestedPiSessionFile: string | null
  reject: (reason: unknown) => void
  resolve: (binding: BuddySessionBinding<TSession>) => void
  shutdownReason: BuddySessionShutdownReason | null
  status: 'disposed' | 'failed' | 'pending' | 'ready'
}

interface ActiveRun {
  runId: string
  signal?: AbortSignal
}

export interface BuddySessionRegistryOptions {
  maxSessions?: number
  onListenerError?: ListenerErrorHandler
}

export interface BuddySessionSnapshot {
  readonly id: string
  readonly identity: Readonly<BuddySessionIdentity>
  readonly model: { readonly providerId: string, readonly modelId: string } | null
  readonly status: 'pending' | 'ready' | 'disposed' | 'failed'
  readonly invalidationPending: boolean
  readonly cleanup: 'none' | 'pending' | 'failed'
  readonly recoveryPending: boolean
  readonly resourceRevisions: readonly BuddyCapabilityResourceRevision[]
}
export interface BuddySessionChange {
  readonly revision: number
  readonly type: 'registered' | 'ready' | 'startup-failed' | 'recovery-acknowledged' | 'invalidation-pending' | 'removed' | 'disposed' | 'cleanup-failed'
  readonly session: BuddySessionSnapshot
}
export interface BuddySessionInvalidationResult {
  readonly matched: number
  readonly pending: number
  readonly degraded: number
}

export interface BuddyRunRelease {
  readonly cleanup: 'completed' | 'degraded'
}

export class BuddySessionRegistry<TSession extends DisposableBuddySession> {
  readonly #activeRuns = new Map<string, ActiveRun>()
  readonly #conversationRoots = new Map<string, string>()
  readonly #identities = new Map<string, BuddySessionIdentity>()
  readonly #pendingInvalidations = new Set<string>()
  readonly #runTails = new Map<string, Promise<void>>()
  readonly #sessions = new Map<string, BuddySessionEntry<TSession>>()
  readonly #lastUsed = new Map<string, number>()
  readonly #maxSessions: number
  readonly #pendingFactories = new Set<Promise<void>>()
  readonly #cleanupFailures: unknown[] = []
  readonly #runCleanup = new Map<string, BuddyRunRelease['cleanup']>()
  readonly #cleanupStates = new Map<string, BuddySessionSnapshot>()
  readonly #changes: Emitter<BuddySessionChange>
  #disposal: Promise<void> | null = null
  #accessSequence = 0
  #revision = 0

  constructor(options: BuddySessionRegistryOptions = {}) {
    this.#maxSessions = Math.max(1, Math.floor(options.maxSessions ?? 8))
    this.#changes = new Emitter(options.onListenerError ?? (() => console.error('SESSION_OBSERVER_FAILED')))
  }

  readonly onDidChange: Event<BuddySessionChange> = (listener, options) => this.#changes.event(listener, options)

  get revision(): number {
    return this.#revision
  }

  snapshot(): readonly BuddySessionSnapshot[] {
    return Object.freeze([...this.#sessions].map(([key, entry]) => this.#snapshotEntry(entry, this.#pendingInvalidations.has(key))).concat([...this.#cleanupStates.values()]))
  }

  async getOrCreate(
    identity: BuddySessionIdentity,
    piSessionFile: string | null,
    factory: () => Promise<BuddySessionBinding<TSession>>,
  ): Promise<BuddySessionBinding<TSession>> {
    if (this.#disposal)
      throw new BuddySessionLifecycleAbortError()
    identity = copyEventSnapshot(identity)
    const conversationKey = createConversationKey(identity)
    const boundRoot = this.#conversationRoots.get(conversationKey)
    if (boundRoot !== undefined && boundRoot !== identity.canonicalRoot)
      throw new BuddySessionBindingError()
    this.#conversationRoots.set(conversationKey, identity.canonicalRoot)

    const sessionKey = createSessionKey(identity)
    const existing = this.#sessions.get(sessionKey)
    if (existing) {
      if (!matchesPiSessionBinding(existing, piSessionFile)) {
        await this.#settleSessionDisposal(sessionKey, 'invalidate', existing)
        throw new BuddySessionBindingError()
      }
      this.#touch(sessionKey)
      return existing.binding ?? existing.promise
    }

    for (const [candidateKey, candidateIdentity] of [...this.#identities]) {
      const candidate = this.#sessions.get(candidateKey)
      if (candidate && createConversationKey(candidateIdentity) === conversationKey)
        await this.#settleSessionDisposal(candidateKey, 'resource-change', candidate)
    }
    if (this.#disposal)
      throw new BuddySessionLifecycleAbortError()
    this.#conversationRoots.set(conversationKey, identity.canonicalRoot)

    const entry = this.#createEntry(identity, piSessionFile, factory)
    this.#sessions.set(sessionKey, entry)
    this.#identities.set(sessionKey, identity)
    this.#publish('registered', this.#snapshotEntry(entry))
    try {
      const binding = await entry.promise
      if (this.#sessions.get(sessionKey) !== entry)
        throw new BuddySessionLifecycleAbortError()
      this.#publish('ready', this.#snapshotEntry(entry, this.#pendingInvalidations.has(sessionKey)))
      this.#touch(sessionKey)
      await this.#evictIdleSessions(sessionKey)
      if (this.#sessions.get(sessionKey) !== entry)
        throw new BuddySessionLifecycleAbortError()
      return binding
    }
    catch (error) {
      if (this.#sessions.get(sessionKey) === entry) {
        this.#sessions.delete(sessionKey)
        this.#identities.delete(sessionKey)
        this.#lastUsed.delete(sessionKey)
        if (![...this.#identities.values()].some(candidate => createConversationKey(candidate) === conversationKey))
          this.#conversationRoots.delete(conversationKey)
        this.#publish('startup-failed', this.#snapshotEntry(entry))
      }
      throw error
    }
  }

  acknowledgeRecovery(identity: BuddySessionIdentity, expected: BuddySessionBinding<TSession>): boolean {
    const key = createSessionKey(identity)
    const entry = this.#sessions.get(key)
    if (!entry || entry.binding !== expected || !expected.recoveredFromProductHistory)
      return false
    const { recoveredFromProductHistory: _recovered, recoveryDegradation: _degradation, ...binding } = expected
    entry.binding = Object.freeze(binding)
    this.#publish('recovery-acknowledged', this.#snapshotEntry(entry, this.#pendingInvalidations.has(key)))
    return true
  }

  getActiveRun(identity: BuddySessionIdentity): ActiveRun | undefined {
    const run = this.#activeRuns.get(createConversationKey(identity))
    return run ? Object.freeze({ ...run }) : undefined
  }

  getReady(conversationId: string, branchId: string): TSession | null {
    for (const [key, identity] of this.#identities) {
      if (identity.conversationId === conversationId && identity.branchId === branchId) {
        const entry = this.#sessions.get(key)
        if (entry?.status === 'ready')
          return entry.binding?.session ?? null
      }
    }
    return null
  }

  invalidateAll(): Promise<number> {
    return this.#invalidate(() => true)
  }

  invalidateMode(mode: BuddySessionIdentity['sessionMode']): Promise<number> {
    return this.#invalidate(identity => identity.sessionMode === mode)
  }

  invalidateRoot(canonicalRoot: string): Promise<number> {
    return this.#invalidate(identity => identity.canonicalRoot === canonicalRoot)
  }

  invalidateSpace(spaceId: string): Promise<number> {
    return this.#invalidate(identity => identity.spaceId === spaceId)
  }

  invalidateConversation(conversationId: string): Promise<number> {
    return this.#invalidate(identity => identity.conversationId === conversationId)
  }

  invalidateConversationWithResult(conversationId: string): Promise<BuddySessionInvalidationResult> {
    return this.invalidateMatching(identity => identity.conversationId === conversationId)
  }

  invalidateSession(identity: BuddySessionIdentity): Promise<number> {
    const sessionKey = createSessionKey(identity)
    return this.#invalidate(candidate => createSessionKey(candidate) === sessionKey)
  }

  async withConversationRun<TResult>(
    identity: BuddySessionIdentity,
    runId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<TResult>,
    onReleased?: (result: BuddyRunRelease) => void,
  ): Promise<TResult> {
    const conversationKey = createConversationKey(identity)
    const previous = this.#runTails.get(conversationKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.#runTails.set(conversationKey, tail)

    await previous
    try {
      if (this.#disposal)
        throw new BuddySessionLifecycleAbortError()
      signal?.throwIfAborted()
      this.#activeRuns.set(conversationKey, { runId, signal })
      this.#runCleanup.set(conversationKey, 'completed')
      return await operation()
    }
    finally {
      this.#activeRuns.delete(conversationKey)
      try {
        await this.#flushInvalidations(conversationKey)
        await this.#evictIdleSessions()
      }
      finally {
        release()
        if (this.#runTails.get(conversationKey) === tail)
          this.#runTails.delete(conversationKey)
        const cleanup = this.#runCleanup.get(conversationKey) ?? 'completed'
        this.#runCleanup.delete(conversationKey)
        onReleased?.({ cleanup })
      }
    }
  }

  dispose(): Promise<void> {
    return this.#disposal ??= Promise.resolve().then(() => this.#dispose())
  }

  async #dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.#sessions.entries()].map(([sessionKey, entry]) =>
      this.#disposeSession(sessionKey, 'quit', entry)))
    await Promise.allSettled([...this.#pendingFactories])
    this.#activeRuns.clear()
    this.#conversationRoots.clear()
    this.#identities.clear()
    this.#lastUsed.clear()
    this.#pendingInvalidations.clear()
    this.#runTails.clear()
    this.#sessions.clear()
    this.#cleanupStates.clear()
    this.#changes.dispose()
    const failures = [...this.#cleanupFailures.splice(0), ...results.filter(result => result.status === 'rejected').map(result => result.reason)]
    if (failures.length)
      throw new AggregateError(failures, 'Session shutdown failed')
  }

  async #invalidate(predicate: (identity: BuddySessionIdentity) => boolean): Promise<number> {
    return (await this.invalidateMatching(predicate)).matched
  }

  async invalidateMatching(predicate: (identity: Readonly<BuddySessionIdentity>) => boolean, options?: { sessionIds: readonly string[] }): Promise<BuddySessionInvalidationResult> {
    const selected = options ? new Set(options.sessionIds) : null
    const affected = new Set([...this.#cleanupStates.values()].filter(entry => (!selected || selected.has(entry.id)) && predicate(entry.identity)).map(entry => entry.id))
    const candidates = [...this.#identities]
      .map(([sessionKey, identity]) => ({
        entry: this.#sessions.get(sessionKey),
        identity,
        sessionKey,
      }))
    for (const { entry, identity, sessionKey } of candidates) {
      if (!entry || (selected && !selected.has(entry.id)) || !predicate(identity))
        continue
      affected.add(entry.id)
      const conversationKey = createConversationKey(identity)
      if (this.#activeRuns.has(conversationKey)) {
        if (!this.#pendingInvalidations.has(sessionKey)) {
          this.#pendingInvalidations.add(sessionKey)
          this.#publish('invalidation-pending', this.#snapshotEntry(entry, true))
        }
        continue
      }
      if (entry)
        await this.#settleSessionDisposal(sessionKey, 'invalidate', entry)
    }
    const remaining = this.snapshot().filter(entry => affected.has(entry.id))
    return Object.freeze({ matched: affected.size, pending: remaining.filter(entry => entry.invalidationPending || entry.cleanup === 'pending').length, degraded: remaining.filter(entry => entry.cleanup === 'failed').length })
  }

  async #flushInvalidations(conversationKey: string): Promise<void> {
    for (const sessionKey of [...this.#pendingInvalidations]) {
      const identity = this.#identities.get(sessionKey)
      if (!identity || createConversationKey(identity) !== conversationKey)
        continue
      this.#pendingInvalidations.delete(sessionKey)
      const entry = this.#sessions.get(sessionKey)
      if (entry)
        await this.#settleSessionDisposal(sessionKey, 'invalidate', entry)
    }
  }

  async #disposeSession(
    sessionKey: string,
    reason: BuddySessionShutdownReason,
    expectedEntry: BuddySessionEntry<TSession>,
  ): Promise<void> {
    const entry = this.#sessions.get(sessionKey)
    if (entry !== expectedEntry)
      return
    const identity = this.#identities.get(sessionKey)
    this.#sessions.delete(sessionKey)
    this.#identities.delete(sessionKey)
    this.#lastUsed.delete(sessionKey)
    this.#pendingInvalidations.delete(sessionKey)
    const removing = copyEventSnapshot({ ...this.#snapshotEntry(entry), status: 'disposed' as const, invalidationPending: false, cleanup: 'pending' as const })
    this.#cleanupStates.set(entry.id, removing)
    this.#publish('removed', removing)
    const pendingFactory = entry.status === 'pending'
    try {
      await this.#disposeEntry(entry, reason)
      if (!pendingFactory)
        this.#finishCleanup(entry)
    }
    catch (error) {
      this.#finishCleanup(entry, true)
      throw error
    }
    finally {
      if (identity) {
        const conversationKey = createConversationKey(identity)
        if (![...this.#identities.values()].some(candidate => createConversationKey(candidate) === conversationKey))
          this.#conversationRoots.delete(conversationKey)
      }
    }
  }

  async #evictIdleSessions(protectedKey?: string): Promise<void> {
    while (this.#sessions.size > this.#maxSessions) {
      const candidate = [...this.#lastUsed.entries()]
        .filter(([sessionKey]) => sessionKey !== protectedKey)
        .filter(([sessionKey]) => {
          const identity = this.#identities.get(sessionKey)
          return identity && !this.#activeRuns.has(createConversationKey(identity))
        })
        .sort((left, right) => left[1] - right[1])[0]?.[0]
      if (!candidate)
        return
      const entry = this.#sessions.get(candidate)
      if (entry)
        await this.#settleSessionDisposal(candidate, 'evict', entry)
    }
  }

  async #settleSessionDisposal(
    sessionKey: string,
    reason: BuddySessionShutdownReason,
    entry: BuddySessionEntry<TSession>,
  ): Promise<void> {
    const identity = this.#identities.get(sessionKey)
    const conversationKey = identity ? createConversationKey(identity) : undefined
    const degrade = () => {
      if (conversationKey && this.#runCleanup.has(conversationKey))
        this.#runCleanup.set(conversationKey, 'degraded')
    }
    if (entry.status === 'pending')
      degrade()
    await this.#disposeSession(sessionKey, reason, entry).catch(degrade)
  }

  #createEntry(
    identity: BuddySessionIdentity,
    requestedPiSessionFile: string | null,
    factory: () => Promise<BuddySessionBinding<TSession>>,
  ): BuddySessionEntry<TSession> {
    let reject!: (reason: unknown) => void
    let resolve!: (binding: BuddySessionBinding<TSession>) => void
    const promise = new Promise<BuddySessionBinding<TSession>>((resolvePromise, rejectPromise) => {
      reject = rejectPromise
      resolve = resolvePromise
    })
    const entry: BuddySessionEntry<TSession> = {
      id: randomUUID(),
      identity,
      binding: null,
      promise,
      requestedPiSessionFile,
      reject,
      resolve,
      shutdownReason: null,
      status: 'pending',
    }
    let factoryPromise: Promise<BuddySessionBinding<TSession>>
    try {
      factoryPromise = factory()
    }
    catch (error) {
      factoryPromise = Promise.reject(error)
    }
    const completion = factoryPromise.then(
      async (binding) => {
        if (entry.status === 'disposed') {
          const reason = entry.shutdownReason ?? 'invalidate'
          await binding.session.shutdown(reason)
          this.#finishCleanup(entry)
          return
        }
        entry.binding = Object.freeze({ ...binding, resourceRevisions: copyEventSnapshot(binding.resourceRevisions ?? []), ...(binding.recoveryDegradation ? { recoveryDegradation: copyEventSnapshot(binding.recoveryDegradation) } : {}) })
        entry.status = 'ready'
        entry.resolve(entry.binding)
      },
      (error) => {
        if (entry.status === 'disposed') {
          this.#finishCleanup(entry)
          return
        }
        if (entry.status !== 'pending')
          return
        entry.status = 'failed'
        entry.reject(error)
      },
    )
    this.#pendingFactories.add(completion)
    void completion.then(() => this.#pendingFactories.delete(completion), (error) => {
      this.#pendingFactories.delete(completion)
      this.#cleanupFailures.push(error)
      this.#finishCleanup(entry, true)
    })
    return entry
  }

  async #disposeEntry(
    entry: BuddySessionEntry<TSession>,
    reason: BuddySessionShutdownReason,
  ): Promise<void> {
    if (entry.status === 'disposed')
      return
    if (entry.status === 'pending') {
      entry.status = 'disposed'
      entry.shutdownReason = reason
      entry.reject(new BuddySessionLifecycleAbortError())
      return
    }
    const binding = entry.binding
    entry.status = 'disposed'
    entry.shutdownReason = reason
    if (binding)
      await binding.session.shutdown(reason)
  }

  #touch(sessionKey: string): void {
    this.#accessSequence += 1
    this.#lastUsed.set(sessionKey, this.#accessSequence)
  }

  #snapshotEntry(entry: BuddySessionEntry<TSession>, invalidationPending = false): BuddySessionSnapshot {
    return copyEventSnapshot({ id: entry.id, identity: entry.identity, model: entry.binding?.session.getModelUsage?.() ?? null, status: entry.status, invalidationPending, cleanup: 'none', recoveryPending: entry.binding?.recoveredFromProductHistory === true, resourceRevisions: entry.binding?.resourceRevisions ?? [] })
  }

  #publish(type: BuddySessionChange['type'], session: BuddySessionSnapshot): void {
    this.#changes.fire(Object.freeze({ type, session, revision: ++this.#revision }))
  }

  #finishCleanup(entry: BuddySessionEntry<TSession>, failed = false): void {
    const snapshot = copyEventSnapshot({ ...this.#snapshotEntry(entry), cleanup: failed ? 'failed' as const : 'none' as const })
    if (failed)
      this.#cleanupStates.set(entry.id, snapshot)
    else
      this.#cleanupStates.delete(entry.id)
    this.#publish(failed ? 'cleanup-failed' : 'disposed', snapshot)
  }
}

export class BuddySessionBindingError extends Error {
  readonly code = 'SESSION_BINDING_MISMATCH'

  constructor() {
    super('Lexora Buddy session binding does not match the conversation branch')
    this.name = 'BuddySessionBindingError'
  }
}

class BuddySessionLifecycleAbortError extends Error {
  constructor() {
    super('Lexora Buddy session lifecycle ended before startup completed')
    this.name = 'AbortError'
  }
}

function createConversationKey(identity: BuddySessionIdentity): string {
  return identity.conversationId
}

function createSessionKey(identity: BuddySessionIdentity): string {
  return [
    createConversationKey(identity),
    identity.branchId,
    identity.canonicalRoot,
    identity.approvalPolicy,
    identity.executionProfile,
    identity.sessionMode,
    identity.grantRevision,
    identity.resourceRevision,
  ].join('\0')
}

function matchesPiSessionBinding<TSession>(
  entry: BuddySessionEntry<TSession>,
  piSessionFile: string | null,
): boolean {
  return entry.status === 'ready'
    ? entry.binding?.piSessionFile === piSessionFile
    : entry.requestedPiSessionFile === piSessionFile
}
