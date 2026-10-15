import type { FileResourceCoordinator } from '../files/FileResourceCoordinator'
import type { MutationRepository, OwnedProcessSettlement } from './mutationRepository'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type MutationClaim
  = { kind: 'file' | 'tree', canonicalPath: string }
    | { kind: 'host' }

export type MutationLifetime = 'runtime' | 'external'

export interface MutationIdentity {
  runId: string
  invocationId: string
}

export interface MutationHazard extends MutationIdentity {
  claims: readonly MutationClaim[]
  reason: string
}

export interface MutationRunState {
  pending: number
  active: number
  hazards: readonly MutationHazard[]
}

export interface MutationLease extends MutationIdentity {
  segmentId: string
  lifetime: MutationLifetime
  sequence: number
  claims: readonly MutationClaim[]
  release: () => void
  markHazard: (reason: string) => void
}

interface PendingMutation extends MutationIdentity {
  claims: readonly MutationClaim[]
  lifetime: MutationLifetime
  signal: AbortSignal
  resolve: (lease: MutationLease) => void
  reject: (error: unknown) => void
  unsubscribe: () => void
}

export class MutationCoordinatorError extends Error {
  readonly code: 'MUTATION_RESOURCE_UNSAFE' | 'MUTATION_COORDINATOR_STOPPED' | 'MUTATION_INVOCATION_CONFLICT'

  constructor(code: MutationCoordinatorError['code']) {
    super(code)
    this.code = code
    this.name = 'MutationCoordinatorError'
  }
}

export class MutationCoordinator {
  readonly #active = new Map<string, MutationLease>()
  readonly #hazards = new Map<string, MutationHazard>()
  readonly #pending: PendingMutation[] = []
  readonly #invocation = new AsyncLocalStorage<MutationLease>()
  readonly #processes = new Map<string, Map<string, OwnedProcessSettlement>>()
  readonly #resources: FileResourceCoordinator | undefined
  readonly #settlements = new Set<Promise<void>>()
  readonly #repository: MutationRepository | undefined
  readonly #changes = new Emitter<{ runId: string }>(() => console.error('MUTATION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #lastWriter: { runId: string, segmentId: string } | undefined
  #sequence = 0
  #disposed = false

  constructor(options: { repository?: MutationRepository, resources?: FileResourceCoordinator } = {}) {
    this.#resources = options.resources
    const repository = options.repository
    this.#repository = repository
    if (!repository)
      return
    for (const stored of repository.listUnreleased()) {
      if (stored.processes.length ? stored.processes.every(process => process.settlement === 'released') : stored.lifetime === 'runtime') {
        repository.settle(stored.invocationId, 'released', null)
        continue
      }
      this.#processes.set(stored.invocationId, new Map(stored.processes.map(process => [process.processId, process.settlement])))
      this.restoreHazard({ runId: stored.runId, invocationId: stored.invocationId, claims: stored.claims, reason: stored.reason ?? 'MUTATION_INTERRUPTED' })
    }
  }

  async acquire(input: MutationIdentity & { claims: readonly MutationClaim[], lifetime: MutationLifetime, signal: AbortSignal }): Promise<MutationLease> {
    if (this.#disposed)
      return Promise.reject(new MutationCoordinatorError('MUTATION_COORDINATOR_STOPPED'))
    input.signal.throwIfAborted()
    if (this.#active.has(input.invocationId) || this.#hazards.has(input.invocationId) || this.#pending.some(pending => pending.invocationId === input.invocationId))
      return Promise.reject(new MutationCoordinatorError('MUTATION_INVOCATION_CONFLICT'))
    const claims = normalizeClaims(input.claims)
    const lease = await new Promise<MutationLease>((resolve, reject) => {
      const pending: PendingMutation = {
        runId: input.runId,
        invocationId: input.invocationId,
        claims,
        lifetime: input.lifetime,
        signal: input.signal,
        resolve,
        reject,
        unsubscribe: () => {},
      }
      const cancel = () => {
        const index = this.#pending.indexOf(pending)
        if (index < 0)
          return
        this.#pending.splice(index, 1)
        pending.unsubscribe()
        reject(input.signal.reason)
        this.#publish(input.runId)
        this.#drain()
      }
      pending.unsubscribe = () => input.signal.removeEventListener('abort', cancel)
      input.signal.addEventListener('abort', cancel, { once: true })
      this.#pending.push(pending)
      this.#publish(input.runId)
      this.#drain()
    })
    try {
      await this.#resources?.acquire(lease.invocationId, lease.claims, lease.lifetime, input.signal)
      input.signal.throwIfAborted()
      return lease
    }
    catch (error) {
      lease.release()
      throw error
    }
  }

  async initialize(): Promise<void> {
    await this.#resources?.reconcile([...this.#hazards.values()], id => this.#repository?.isReleased(id) === true)
  }

  getRunState(runId: string): MutationRunState {
    return copyEventSnapshot({
      pending: this.#pending.filter(pending => pending.runId === runId).length,
      active: [...this.#active.values()].filter(lease => lease.runId === runId).length,
      hazards: [...this.#hazards.values()].filter(hazard => hazard.runId === runId),
    })
  }

  withInvocation<T>(lease: MutationLease, operation: () => Promise<T>): Promise<T> {
    return this.#invocation.run(lease, operation)
  }

  getCurrentInvocation(): MutationIdentity | null {
    const lease = this.#invocation.getStore()
    return lease ? Object.freeze({ runId: lease.runId, invocationId: lease.invocationId }) : null
  }

  recordOwnedProcessSettlement(input: { invocationId?: string, processId: string, settlement: 'pending' | 'released' | 'unknown' }): boolean {
    const invocationId = input.invocationId ?? this.#invocation.getStore()?.invocationId
    if (!invocationId || (!this.#active.has(invocationId) && !this.#hazards.has(invocationId)))
      return false
    const processes = this.#processes.get(invocationId) ?? new Map<string, 'pending' | 'released' | 'unknown'>()
    if (processes.get(input.processId) === 'released')
      return true
    this.#repository?.recordProcess(invocationId, input.processId, input.settlement)
    processes.set(input.processId, input.settlement)
    this.#processes.set(invocationId, processes)
    if (this.#hazards.has(invocationId) && [...processes.values()].every(value => value === 'released'))
      this.confirmReleased(invocationId)
    return true
  }

  getInvocationSettlement(invocationId: string): 'none' | 'released' | 'unknown' {
    const processes = this.#processes.get(invocationId)
    if (!processes?.size)
      return 'none'
    return [...processes.values()].every(value => value === 'released') ? 'released' : 'unknown'
  }

  async waitForRun(runId: string): Promise<MutationRunState> {
    const current = this.getRunState(runId)
    if (!current.pending && !current.active)
      return current
    return new Promise((resolve) => {
      const subscription = this.onDidChange((event) => {
        if (event.runId !== runId)
          return
        const state = this.getRunState(runId)
        if (!state.pending && !state.active) {
          subscription.dispose()
          resolve(state)
        }
      })
    })
  }

  restoreHazard(hazard: MutationHazard): void {
    if (this.#active.has(hazard.invocationId))
      throw new MutationCoordinatorError('MUTATION_INVOCATION_CONFLICT')
    this.#hazards.set(hazard.invocationId, copyEventSnapshot({ ...hazard, claims: normalizeClaims(hazard.claims) }))
    this.#publish(hazard.runId)
    this.#drain()
  }

  confirmReleased(invocationId: string): void {
    const hazard = this.#hazards.get(invocationId)
    if (!hazard)
      return
    this.#repository?.settle(invocationId, 'released', null)
    this.#settleResource(invocationId, false)
    this.#hazards.delete(invocationId)
    this.#processes.delete(invocationId)
    this.#publish(hazard.runId)
    this.#drain()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const pending of this.#pending.splice(0)) {
      pending.unsubscribe()
      pending.reject(new MutationCoordinatorError('MUTATION_COORDINATOR_STOPPED'))
      this.#publish(pending.runId)
    }
    await Promise.allSettled(this.#settlements)
  }

  #drain(): void {
    for (let index = 0; index < this.#pending.length;) {
      const pending = this.#pending[index]!
      if ([...this.#hazards.values()].some(hazard => claimsOverlap(hazard.claims, pending.claims))) {
        this.#pending.splice(index, 1)
        pending.unsubscribe()
        pending.reject(new MutationCoordinatorError('MUTATION_RESOURCE_UNSAFE'))
        this.#publish(pending.runId)
        continue
      }
      if ([...this.#active.values()].some(lease => claimsOverlap(lease.claims, pending.claims))
        || this.#pending.slice(0, index).some(earlier => claimsOverlap(earlier.claims, pending.claims))) {
        index++
        continue
      }
      this.#pending.splice(index, 1)
      pending.unsubscribe()
      const segmentId = this.#lastWriter?.runId === pending.runId ? this.#lastWriter.segmentId : randomUUID()
      this.#lastWriter = { runId: pending.runId, segmentId }
      const lease: MutationLease = {
        runId: pending.runId,
        invocationId: pending.invocationId,
        segmentId,
        sequence: ++this.#sequence,
        claims: pending.claims,
        lifetime: pending.lifetime,
        release: () => this.#release(lease),
        markHazard: reason => this.#release(lease, reason),
      }
      try {
        this.#repository?.createLease(lease)
      }
      catch (error) {
        pending.reject(error)
        this.#publish(pending.runId)
        continue
      }
      this.#active.set(lease.invocationId, lease)
      pending.resolve(lease)
      this.#publish(lease.runId)
    }
  }

  #release(lease: MutationLease, hazard?: string): void {
    if (this.#active.get(lease.invocationId) !== lease)
      return
    try {
      this.#repository?.settle(lease.invocationId, hazard ? 'hazard' : 'released', hazard ?? null)
    }
    catch {
      hazard = 'MUTATION_SETTLEMENT_PERSISTENCE_FAILED'
    }
    this.#settleResource(lease.invocationId, Boolean(hazard))
    this.#active.delete(lease.invocationId)
    if (hazard) {
      this.#hazards.set(lease.invocationId, copyEventSnapshot({
        runId: lease.runId,
        invocationId: lease.invocationId,
        claims: lease.claims,
        reason: hazard,
      }))
    }
    else {
      this.#processes.delete(lease.invocationId)
    }
    this.#publish(lease.runId)
    this.#drain()
  }

  #settleResource(id: string, hazard: boolean): void {
    if (!this.#resources)
      return
    const pending = this.#resources.release(id, hazard).catch(() => {
      console.error('FILE_RESOURCE_SETTLEMENT_FAILED')
    }).finally(() => this.#settlements.delete(pending))
    this.#settlements.add(pending)
  }

  #publish(runId: string): void {
    this.#changes.fire(Object.freeze({ runId }))
  }
}

function normalizeClaims(claims: readonly MutationClaim[]): readonly MutationClaim[] {
  if (claims.some(claim => claim.kind === 'host'))
    return Object.freeze([Object.freeze({ kind: 'host' as const })])
  const result: MutationClaim[] = []
  for (const claim of claims) {
    if (claim.kind === 'host')
      continue
    const canonicalPath = filePaths.resolveInput(claim.canonicalPath)
    if (!result.some(existing => existing.kind !== 'host' && existing.kind === claim.kind && pathKey(existing.canonicalPath) === pathKey(canonicalPath)))
      result.push({ kind: claim.kind, canonicalPath })
  }
  return copyEventSnapshot(result)
}

function claimsOverlap(left: readonly MutationClaim[], right: readonly MutationClaim[]): boolean {
  return left.some(a => right.some((b) => {
    if (a.kind === 'host' || b.kind === 'host')
      return true
    const leftPath = pathKey(a.canonicalPath)
    const rightPath = pathKey(b.canonicalPath)
    return leftPath === rightPath
      || (a.kind === 'tree' && containsCanonicalPath(leftPath, rightPath))
      || (b.kind === 'tree' && containsCanonicalPath(rightPath, leftPath))
  }))
}

function pathKey(path: string): string {
  return filePaths.sensitiveKey(path)
}
